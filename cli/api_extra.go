package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Endpoints the desktop app needs beyond the CLI surface: the terminal
// stream, the Resources and Ports screens, Settings, the Add Server form and
// agent onboarding. The macOS app does these in-process; here the daemon
// owns the processes, so the Tauri UI asks it over the same local API.

func (s *apiServer) registerAppRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/output", s.get(s.output))
	mux.HandleFunc("/output/clear", s.post(s.clearOutput))
	mux.HandleFunc("/input", s.post(s.input))
	mux.HandleFunc("/resize", s.post(s.resize))
	mux.HandleFunc("/listeners", s.get(s.listeners))
	mux.HandleFunc("/resources", s.get(s.resources))
	mux.HandleFunc("/processes/stop", s.post(s.stopProcess))
	mux.HandleFunc("/config/update", s.post(s.updateSettings))
	mux.HandleFunc("/projects/update", s.post(s.updateProject))
	mux.HandleFunc("/detect", s.get(s.detect))
	mux.HandleFunc("/next-port", s.get(s.nextPort))
	mux.HandleFunc("/agent-setup", s.agentSetup)
	mux.HandleFunc("/forever", s.forever)
}

// allowedOrigins are the webview origins of the Tauri app (production on
// Windows and macOS/Linux). The Vite dev server origin is added only when
// PORTLY_DEV_ORIGIN=1, so a page on localhost:1420 cannot drive a release
// daemon.
var allowedOrigins = map[string]bool{
	"tauri://localhost":       true,
	"http://tauri.localhost":  true,
	"https://tauri.localhost": true,
}

func init() {
	if os.Getenv("PORTLY_DEV_ORIGIN") == "1" {
		allowedOrigins["http://localhost:1420"] = true
	}
}

// loopbackHost reports whether a Host header names this machine. Anything
// else is a DNS-rebinding page that resolved its own name to 127.0.0.1.
func loopbackHost(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	switch strings.ToLower(host) {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}

// withOriginGuard lets the app's webview call the API and refuses every other
// browser origin, so a web page cannot drive local processes. Requests with
// no Origin (the CLI, curl) pass through unchanged, but every request must
// name a loopback Host.
func withOriginGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHost(r.Host) {
			writeFail(w, http.StatusForbidden, "Host not allowed")
			return
		}
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		if !allowedOrigins[origin] {
			writeFail(w, http.StatusForbidden, "Origin not allowed")
			return
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Vary", "Origin")
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type")
		h.Set("Access-Control-Allow-Private-Network", "true")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// MARK: terminal stream

type outputChunk struct {
	Offset uint64 `json:"offset"`
	Data   string `json:"data"`
	Reset  bool   `json:"reset"`
}

type serverRequest struct {
	Server string `json:"server"`
}

func (s *apiServer) runtimeFor(w http.ResponseWriter, query string) *serverRuntime {
	rt := s.sup.resolveRuntime(query)
	if rt == nil {
		writeFail(w, http.StatusNotFound, "No server matching '"+query+"'")
	}
	return rt
}

func (s *apiServer) output(w http.ResponseWriter, r *http.Request) {
	rt := s.runtimeFor(w, r.URL.Query().Get("server"))
	if rt == nil {
		return
	}
	since, _ := strconv.ParseUint(r.URL.Query().Get("since"), 10, 64)
	var (
		next  uint64
		data  []byte
		reset bool
	)
	if r.URL.Query().Get("wait") == "1" {
		next, data, reset = rt.logs.waitRaw(since, 25*time.Second, r.Context().Done())
	} else {
		rt.logs.mu.Lock()
		next, data, reset = rt.logs.rawSinceLocked(since)
		rt.logs.mu.Unlock()
	}
	writeOK(w, outputChunk{Offset: next, Data: string(data), Reset: reset})
}

func (s *apiServer) clearOutput(w http.ResponseWriter, r *http.Request) {
	var body serverRequest
	if err := decodeBody(r, &body); err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	rt := s.runtimeFor(w, body.Server)
	if rt == nil {
		return
	}
	rt.logs.clearRaw()
	writeOK(w, actionResponse{Affected: []string{rt.id}, Message: "Cleared output of " + rt.config.Name})
}

func (s *apiServer) input(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Server string `json:"server"`
		Data   string `json:"data"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	rt := s.runtimeFor(w, body.Server)
	if rt == nil {
		return
	}
	rt.mu.Lock()
	child := rt.child
	rt.mu.Unlock()
	if child == nil {
		writeFail(w, http.StatusConflict, rt.config.Name+" is not running")
		return
	}
	if err := child.write([]byte(body.Data)); err != nil {
		writeFail(w, http.StatusConflict, err.Error())
		return
	}
	writeOK(w, actionResponse{Affected: []string{rt.id}, Message: "ok"})
}

func (s *apiServer) resize(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Server string `json:"server"`
		Cols   int    `json:"cols"`
		Rows   int    `json:"rows"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Cols < 2 || body.Rows < 2 || body.Cols > 1000 || body.Rows > 1000 {
		writeFail(w, http.StatusBadRequest, "Invalid terminal size")
		return
	}
	rt := s.runtimeFor(w, body.Server)
	if rt == nil {
		return
	}
	rt.mu.Lock()
	child := rt.child
	rt.mu.Unlock()
	if child != nil {
		_ = child.resize(body.Cols, body.Rows)
	}
	writeOK(w, actionResponse{Affected: []string{rt.id}, Message: "ok"})
}

// MARK: ports and processes

type listenerRow struct {
	Port                 int    `json:"port"`
	PID                  int    `json:"pid"`
	Command              string `json:"command"`
	User                 string `json:"user"`
	Address              string `json:"address"`
	Executable           string `json:"executable,omitempty"`
	WorkingDirectory     string `json:"workingDirectory,omitempty"`
	DockerContainerID    string `json:"dockerContainerID,omitempty"`
	DockerContainerName  string `json:"dockerContainerName,omitempty"`
	DockerComposeProject string `json:"dockerComposeProject,omitempty"`
	DockerComposeService string `json:"dockerComposeService,omitempty"`
}

func (s *apiServer) listeners(w http.ResponseWriter, _ *http.Request) {
	rows := []listenerRow{}
	for _, l := range allListeners() {
		row := listenerRow{
			Port: l.Port, PID: l.PID, Command: l.Command, User: l.User, Address: l.Address,
			Executable:       processExecutable(l.PID),
			WorkingDirectory: processWorkingDirectory(l.PID),
		}
		// Asking Docker costs a CLI round trip, so only for its own proxies.
		if isDockerProxy(l.Command) {
			if c := dockerContainerPublishing(l.Port); c != nil {
				row.DockerContainerID, row.DockerContainerName = c.ID, c.Name
				row.DockerComposeProject, row.DockerComposeService = c.ComposeProject, c.ComposeService
			}
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Port < rows[j].Port })
	writeOK(w, rows)
}

func isDockerProxy(command string) bool {
	lower := strings.ToLower(command)
	return isDockerDaemonCommand(command) || strings.Contains(lower, "docker") ||
		strings.Contains(lower, "wslrelay") || strings.Contains(lower, "vpnkit")
}

type managedProcessRow struct {
	ServerID       string  `json:"serverID"`
	PID            int     `json:"pid"`
	ParentPID      int     `json:"parentPID"`
	Name           string  `json:"name"`
	Command        string  `json:"command"`
	FootprintBytes uint64  `json:"footprintBytes"`
	ResidentBytes  uint64  `json:"residentBytes"`
	CPUPercent     float64 `json:"cpuPercent"`
	ProcessCount   int     `json:"processCount"`
}

type externalProcessRow struct {
	PID                int     `json:"pid"`
	ParentPID          int     `json:"parentPID"`
	Name               string  `json:"name"`
	Command            string  `json:"command"`
	ParentCommand      string  `json:"parentCommand,omitempty"`
	FootprintBytes     uint64  `json:"footprintBytes"`
	ResidentBytes      uint64  `json:"residentBytes"`
	CPUPercent         float64 `json:"cpuPercent"`
	StartTime          int64   `json:"startTime"`
	Executable         string  `json:"executable,omitempty"`
	WorkingDirectory   string  `json:"workingDirectory,omitempty"`
	ListeningPorts     []int   `json:"listeningPorts"`
	TerminationPID     int     `json:"terminationPID"`
	TerminationName    string  `json:"terminationName"`
	TerminationCommand string  `json:"terminationCommand,omitempty"`
	IsDevLauncher      bool    `json:"isDevLauncher"`
}

type resourceSample struct {
	SampledAt            time.Time            `json:"sampledAt"`
	TotalMemoryBytes     uint64               `json:"totalMemoryBytes"`
	AvailableMemoryBytes uint64               `json:"availableMemoryBytes"`
	CPUCount             int                  `json:"cpuCount"`
	DaemonPID            int                  `json:"daemonPID"`
	Managed              []managedProcessRow  `json:"managed"`
	External             []externalProcessRow `json:"external"`
}

const (
	externalMinimumFootprint = 16 << 20
	externalProcessLimit     = 30
)

// processTable is one listProcesses snapshot with the lookups the Resources
// screen needs: parent links and which managed server owns each process.
type processTable struct {
	records  map[int]procRecord
	owner    map[int]string
	self     int
	sameUser func(int) bool
}

func (s *apiServer) snapshotProcesses() processTable {
	roots := map[int]string{}
	for _, rt := range s.sup.allRuntimes() {
		if pid := rt.currentPID(); pid > 0 {
			roots[pid] = rt.id
		}
	}
	t := processTable{records: map[int]procRecord{}, owner: map[int]string{}, self: os.Getpid(), sameUser: sameUserProcess}
	for _, rec := range listProcesses() {
		t.records[rec.PID] = rec
	}
	for pid := range t.records {
		seen := map[int]bool{}
		for current := pid; current > 0 && !seen[current]; {
			seen[current] = true
			if id, ok := roots[current]; ok {
				t.owner[pid] = id
				break
			}
			parent, ok := t.records[current]
			if !ok {
				break
			}
			current = parent.ParentPID
		}
	}
	return t
}

// stoppable reports whether Portly may offer to stop pid from Resources.
func (t processTable) stoppable(pid int) bool {
	if pid <= 4 || pid == t.self || t.owner[pid] != "" {
		return false
	}
	if rec, ok := t.records[pid]; ok {
		name := strings.ToLower(rec.Command)
		if name == "portly" || name == "portlyd" {
			return false
		}
	}
	return t.sameUser(pid)
}

// terminationTarget walks up from pid and returns the outermost dev launcher
// (`pnpm dev` above `next dev` above node), so stopping a hungry worker stops
// the whole server instead of letting its launcher respawn it.
func (t processTable) terminationTarget(pid int, commandLine func(int) string) int {
	target := pid
	seen := map[int]bool{}
	current := pid
	for {
		rec, ok := t.records[current]
		if !ok || seen[current] {
			break
		}
		seen[current] = true
		parent := rec.ParentPID
		if parent == current || !t.stoppable(parent) {
			break
		}
		if _, ok := t.records[parent]; !ok {
			break
		}
		if isDevLauncher(commandLine(parent)) {
			target = parent
		}
		current = parent
	}
	return target
}

var viteWord = regexp.MustCompile(`(^|\s)vite(\s|$)`)

var devLauncherPhrases = []string{
	"pnpm dev", "pnpm run dev", "npm run dev", "yarn dev", "yarn run dev",
	"bun run dev", "bun dev", "next dev", "nuxt dev", "astro dev", "remix dev",
}

func isDevLauncher(commandLine string) bool {
	normalized := normalizeCommandLine(commandLine)
	for _, phrase := range devLauncherPhrases {
		if strings.Contains(normalized, phrase) {
			return true
		}
	}
	return viteWord.MatchString(normalized) && !strings.Contains(normalized, "helper")
}

// normalizeCommandLine reduces `"C:\…\node.exe" C:\…\pnpm.cjs dev` to
// `node pnpm dev` so launcher detection works on any OS's command lines.
func normalizeCommandLine(commandLine string) string {
	var words []string
	for _, token := range splitCommandLine(commandLine) {
		token = strings.ReplaceAll(token, `\`, "/")
		if i := strings.LastIndex(token, "/"); i >= 0 && i < len(token)-1 {
			token = token[i+1:]
		}
		lower := strings.ToLower(token)
		for _, ext := range []string{".exe", ".cmd", ".cjs", ".mjs", ".js"} {
			lower = strings.TrimSuffix(lower, ext)
		}
		words = append(words, lower)
	}
	return strings.Join(words, " ")
}

func splitCommandLine(s string) []string {
	var out []string
	var b strings.Builder
	quoted, inToken := false, false
	for _, r := range s {
		switch {
		case r == '"':
			quoted = !quoted
			inToken = true
		case (r == ' ' || r == '\t') && !quoted:
			if inToken {
				out = append(out, b.String())
				b.Reset()
				inToken = false
			}
		default:
			b.WriteRune(r)
			inToken = true
		}
	}
	if inToken {
		out = append(out, b.String())
	}
	return out
}

func (s *apiServer) resources(w http.ResponseWriter, _ *http.Request) {
	table := s.snapshotProcesses()
	total, available := systemMemory()
	sample := resourceSample{
		SampledAt:            time.Now(),
		TotalMemoryBytes:     total,
		AvailableMemoryBytes: available,
		CPUCount:             runtime.NumCPU(),
		DaemonPID:            table.self,
		Managed:              []managedProcessRow{},
		External:             []externalProcessRow{},
	}
	var candidates []procRecord
	for pid, rec := range table.records {
		if id := table.owner[pid]; id != "" {
			sample.Managed = append(sample.Managed, managedProcessRow{
				ServerID: id, PID: pid, ParentPID: rec.ParentPID, Name: rec.Command,
				Command:        processCommandLine(pid),
				FootprintBytes: rec.Footprint, ResidentBytes: rec.RSSBytes,
				CPUPercent: rec.CPUPercent, ProcessCount: 1,
			})
			continue
		}
		if rec.Footprint < externalMinimumFootprint || !table.stoppable(pid) {
			continue
		}
		candidates = append(candidates, rec)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].RSSBytes > candidates[j].RSSBytes })
	if len(candidates) > externalProcessLimit {
		candidates = candidates[:externalProcessLimit]
	}

	commandLines := map[int]string{}
	commandLine := func(pid int) string {
		if line, ok := commandLines[pid]; ok {
			return line
		}
		line := processCommandLine(pid)
		if line == "" {
			line = table.records[pid].Command
		}
		commandLines[pid] = line
		return line
	}

	listed := map[int]bool{}
	for _, rec := range candidates {
		listed[rec.PID] = true
	}
	// A port belongs to the listening process and every listed ancestor, so
	// a launcher row shows the port its worker serves.
	ports := map[int][]int{}
	for _, l := range allListeners() {
		seen := map[int]bool{}
		for current := l.PID; current > 0 && !seen[current]; current = table.records[current].ParentPID {
			seen[current] = true
			if listed[current] && !containsInt(ports[current], l.Port) {
				ports[current] = append(ports[current], l.Port)
			}
			if _, ok := table.records[current]; !ok {
				break
			}
		}
	}

	for _, rec := range candidates {
		target := table.terminationTarget(rec.PID, commandLine)
		row := externalProcessRow{
			PID: rec.PID, ParentPID: rec.ParentPID, Name: rec.Command,
			Command:        commandLine(rec.PID),
			FootprintBytes: rec.Footprint, ResidentBytes: rec.RSSBytes,
			CPUPercent:       rec.CPUPercent,
			StartTime:        startTimeToken(rec.StartTime),
			Executable:       processExecutable(rec.PID),
			WorkingDirectory: processWorkingDirectory(rec.PID),
			ListeningPorts:   ports[rec.PID],
			TerminationPID:   target,
			TerminationName:  table.records[target].Command,
			IsDevLauncher:    isDevLauncher(commandLine(rec.PID)),
		}
		if row.ListeningPorts == nil {
			row.ListeningPorts = []int{}
		}
		sort.Ints(row.ListeningPorts)
		if _, ok := table.records[rec.ParentPID]; ok {
			row.ParentCommand = commandLine(rec.ParentPID)
		}
		if target != rec.PID {
			row.TerminationCommand = commandLine(target)
		}
		sample.External = append(sample.External, row)
	}
	writeOK(w, sample)
}

func containsInt(values []int, v int) bool {
	for _, x := range values {
		if x == v {
			return true
		}
	}
	return false
}

func (s *apiServer) stopProcess(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PID       int   `json:"pid"`
		StartTime int64 `json:"startTime"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	table := s.snapshotProcesses()
	rec, ok := table.records[body.PID]
	if !ok {
		writeFail(w, http.StatusNotFound, fmt.Sprintf("Process %d is no longer running", body.PID))
		return
	}
	// The start time pins the identity: a reused pid must not be stopped.
	if startTimeToken(rec.StartTime) != body.StartTime {
		writeFail(w, http.StatusConflict, "The process changed before Portly could stop it. Refresh and try again.")
		return
	}
	if !table.stoppable(body.PID) {
		writeFail(w, http.StatusForbidden, fmt.Sprintf("Portly will not stop %s (pid %d)", rec.Command, body.PID))
		return
	}
	target := table.terminationTarget(body.PID, processCommandLine)
	name := table.records[target].Command
	// The target may be an ancestor; pin its identity too before the tree kill.
	if target != body.PID && !stillSameProcess(target, table.records[target].StartTime) {
		writeFail(w, http.StatusConflict, "The process changed before Portly could stop it. Refresh and try again.")
		return
	}
	if err := terminatePID(target); err != nil {
		writeFail(w, http.StatusBadRequest, fmt.Sprintf("Process %d refused the stop request.", target))
		return
	}
	writeOK(w, actionResponse{Affected: []string{strconv.Itoa(target)}, Message: fmt.Sprintf("Stopped %s (pid %d)", name, target)})
}

func stillSameProcess(pid int, start uint64) bool {
	for _, rec := range listProcesses() {
		if rec.PID == pid {
			return rec.StartTime == start
		}
	}
	return false
}

// MARK: settings and projects

type settingsUpdate struct {
	HealthIntervalSeconds *int `json:"healthIntervalSeconds"`
	MaxRestartAttempts    *int `json:"maxRestartAttempts"`
	LogBufferLines        *int `json:"logBufferLines"`
	LogFileMaxMB          *int `json:"logFileMaxMB"`
	APIPort               *int `json:"apiPort"`
}

func (u settingsUpdate) validate() error {
	check := func(v *int, lo, hi int, label string) error {
		if v != nil && (*v < lo || *v > hi) {
			return fmt.Errorf("%s must be between %d and %d", label, lo, hi)
		}
		return nil
	}
	for _, err := range []error{
		check(u.HealthIntervalSeconds, 1, 3600, "healthIntervalSeconds"),
		check(u.MaxRestartAttempts, 0, 100, "maxRestartAttempts"),
		check(u.LogBufferLines, 100, 1_000_000, "logBufferLines"),
		check(u.LogFileMaxMB, 1, 1024, "logFileMaxMB"),
		check(u.APIPort, 1024, 65535, "apiPort"),
	} {
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *supervisor) updateSettings(u settingsUpdate) PortlyConfig {
	s.store.mutate(func(cfg *PortlyConfig) {
		set := func(dst *int, v *int) {
			if v != nil {
				*dst = *v
			}
		}
		set(&cfg.HealthIntervalSeconds, u.HealthIntervalSeconds)
		set(&cfg.MaxRestartAttempts, u.MaxRestartAttempts)
		set(&cfg.LogBufferLines, u.LogBufferLines)
		set(&cfg.LogFileMaxMB, u.LogFileMaxMB)
		// A new API port takes effect the next time the daemon starts.
		set(&cfg.APIPort, u.APIPort)
	})
	s.mu.Lock()
	s.syncRuntimes()
	s.mu.Unlock()
	return s.store.current()
}

func (s *apiServer) updateSettings(w http.ResponseWriter, r *http.Request) {
	var body settingsUpdate
	if err := decodeBody(r, &body); err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := body.validate(); err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOK(w, s.sup.updateSettings(body))
}

type projectUpdate struct {
	Project string  `json:"project"`
	Name    *string `json:"name"`
	Root    *string `json:"root"`
	Icon    *string `json:"icon"`
	Color   *string `json:"color"`
}

var hexColor = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

func (s *supervisor) updateProject(id string, u projectUpdate) {
	s.store.mutate(func(cfg *PortlyConfig) {
		for i := range cfg.Projects {
			p := &cfg.Projects[i]
			if p.ID != id {
				continue
			}
			if u.Name != nil {
				p.Name = strings.TrimSpace(*u.Name)
			}
			if u.Root != nil {
				p.Root = expandPath(strings.TrimSpace(*u.Root))
			}
			if u.Icon != nil && *u.Icon != "" {
				p.Icon = *u.Icon
			}
			if u.Color != nil && *u.Color != "" {
				p.Color = *u.Color
			}
		}
	})
	s.mu.Lock()
	s.syncRuntimes()
	s.mu.Unlock()
}

func (s *apiServer) updateProject(w http.ResponseWriter, r *http.Request) {
	var body projectUpdate
	if err := decodeBody(r, &body); err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	project := s.sup.resolveProject(body.Project)
	if project == nil {
		writeFail(w, http.StatusNotFound, "No project matching '"+body.Project+"'")
		return
	}
	if body.Name != nil && strings.TrimSpace(*body.Name) == "" {
		writeFail(w, http.StatusBadRequest, "Project name cannot be empty")
		return
	}
	if body.Root != nil && !dirExists(expandPath(strings.TrimSpace(*body.Root))) {
		writeFail(w, http.StatusBadRequest, "Folder does not exist: "+*body.Root)
		return
	}
	if body.Color != nil && *body.Color != "" && !hexColor.MatchString(*body.Color) {
		writeFail(w, http.StatusBadRequest, "Color must look like #RRGGBB")
		return
	}
	s.sup.updateProject(project.ID, body)
	writeOK(w, actionResponse{Affected: []string{project.ID}, Message: "Updated " + project.Name})
}

// MARK: Add Server form

func (s *apiServer) detect(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if strings.TrimSpace(path) == "" {
		writeFail(w, http.StatusBadRequest, "Missing ?path=")
		return
	}
	reserved := map[int]bool{}
	for _, project := range s.sup.settings().Projects {
		for _, server := range project.Servers {
			if server.Port != nil {
				reserved[*server.Port] = true
			}
		}
	}
	writeOK(w, detectCommands(path, reserved))
}

func (s *apiServer) nextPort(w http.ResponseWriter, r *http.Request) {
	start, err := strconv.Atoi(r.URL.Query().Get("start"))
	if err != nil || start < 1 || start > 65535 {
		start = 3000
	}
	writeOK(w, map[string]int{"port": s.sup.nextAvailablePort(start, r.URL.Query().Get("excluding"))})
}

// MARK: agent onboarding (AgentSetup.swift)

//go:embed skill
var bundledSkill embed.FS

type agentSetupStatus struct {
	CLIInstalled         bool    `json:"cliInstalled"`
	CLIPath              *string `json:"cliPath"`
	SkillInstalled       bool    `json:"skillInstalled"`
	AgentsRulesInstalled bool    `json:"agentsRulesInstalled"`
	ClaudeRulesInstalled bool    `json:"claudeRulesInstalled"`
	Complete             bool    `json:"complete"`
}

const (
	managedRuleStart = "<!-- portly:managed-rule:start -->"
	managedRuleEnd   = "<!-- portly:managed-rule:end -->"
)

func managedRule() string {
	group := "process group"
	if runtime.GOOS == "windows" {
		group = "process tree"
	}
	return managedRuleStart + "\n" +
		"## Development servers\n\n" +
		"- Always use Portly (`portly ...`) to start, stop, restart, inspect, or keep local development servers running.\n" +
		"- Start with `portly status`. Use `portly status --details` only for the full inventory and metrics, and `--json` only for machine-readable fields. Reuse a healthy managed server; if an in-scope server is running outside Portly, register it and use `portly take-over <project/server> --json`.\n" +
		"- For long-lived or reusable work, create a project and server.\n" +
		"- For builds, tests, code generation, previews, demos, and other bounded one-off work, run `job_id=\"$(portly temp '<command>' --path <folder> --timeout 30m)\"`, then `portly wait \"$job_id\"`. `temp` returns immediately with an ID; `wait` prints captured logs and exits with the command's real code. A timeout kills the whole " + group + " and exits with code `124`.\n" +
		"- Never launch persistent development servers directly, in the background, or through another supervisor.\n" +
		managedRuleEnd
}

// installManagedRule replaces Portly's block in place or appends it after a
// blank line, leaving the user's own rules untouched.
func installManagedRule(contents string) string {
	rule := managedRule()
	if start := strings.Index(contents, managedRuleStart); start >= 0 {
		if end := strings.Index(contents[start:], managedRuleEnd); end >= 0 {
			end += start
			// Pair the end marker with the start marker closest to it.
			start = strings.LastIndex(contents[:end], managedRuleStart)
			end += len(managedRuleEnd)
			return contents[:start] + rule + contents[end:]
		}
	}
	updated := contents
	if updated != "" && !strings.HasSuffix(updated, "\n") {
		updated += "\n"
	}
	if updated != "" {
		updated += "\n"
	}
	updated += rule
	if !strings.HasSuffix(updated, "\n") {
		updated += "\n"
	}
	return updated
}

func userHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return home
}

func skillDirectory() string {
	return filepath.Join(userHome(), ".agents", "skills", "portly")
}

func globalRuleFiles() []string {
	home := userHome()
	return []string{
		filepath.Join(home, ".agents", "AGENTS.md"),
		filepath.Join(home, ".claude", "CLAUDE.md"),
	}
}

func resolveSymlinks(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	return path
}

func hasCurrentPortlyRule(path string) bool {
	data, err := os.ReadFile(resolveSymlinks(path))
	if err != nil {
		return false
	}
	text := string(data)
	return strings.Contains(text, "portly:managed-rule:start") && strings.Contains(text, "exits with code `124`")
}

func currentAgentSetup() agentSetupStatus {
	st := agentSetupStatus{SkillInstalled: fileExists(filepath.Join(skillDirectory(), "SKILL.md"))}
	if path, err := exec.LookPath("portly"); err == nil {
		st.CLIInstalled = true
		st.CLIPath = &path
	}
	files := globalRuleFiles()
	st.AgentsRulesInstalled = hasCurrentPortlyRule(files[0])
	st.ClaudeRulesInstalled = hasCurrentPortlyRule(files[1])
	st.Complete = st.SkillInstalled && st.AgentsRulesInstalled && st.ClaudeRulesInstalled
	return st
}

// installSkill copies the embedded skill into a staging folder and swaps it
// in, so a failed copy never leaves a half-written skill behind.
func installSkill() error {
	target := skillDirectory()
	root := filepath.Dir(target)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	staging := filepath.Join(root, ".portly-install-"+newID("tmp"))
	defer os.RemoveAll(staging)
	err := fs.WalkDir(bundledSkill, "skill", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(path, "skill"), "/")
		dest := filepath.Join(staging, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(dest, 0o755)
		}
		data, err := bundledSkill.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(dest, data, 0o644)
	})
	if err != nil {
		return err
	}
	if err := os.RemoveAll(target); err != nil {
		return err
	}
	return os.Rename(staging, target)
}

func installGlobalRules() error {
	for _, configured := range globalRuleFiles() {
		file := resolveSymlinks(configured)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return err
		}
		data, err := os.ReadFile(file)
		if err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("could not read %s: %w", file, err)
		}
		if len(data) >= 2 && (data[0] == 0xFF && data[1] == 0xFE || data[0] == 0xFE && data[1] == 0xFF) {
			return fmt.Errorf("%s is saved as UTF-16; save it as UTF-8 and try again", file)
		}
		contents := string(data)
		if start := strings.Index(contents, managedRuleStart); start >= 0 && !strings.Contains(contents[start:], managedRuleEnd) {
			return fmt.Errorf("%s has a Portly start marker without its end marker; fix it by hand and try again", file)
		}
		// Keep the file's own line endings.
		crlf := strings.Contains(contents, windowsNewline)
		updated := installManagedRule(strings.ReplaceAll(contents, windowsNewline, unixNewline))
		if crlf {
			updated = strings.ReplaceAll(updated, unixNewline, windowsNewline)
		}
		if updated == contents {
			continue
		}
		tmp := file + ".portly-tmp"
		if err := os.WriteFile(tmp, []byte(updated), 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, file); err != nil {
			_ = os.Remove(tmp)
			return err
		}
	}
	return nil
}

// agentSetup answers GET with the current state. POST performs the next step
// (the skill, then the rules), or the one named by {"step":"skill"|"rules"}.
func (s *apiServer) agentSetup(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeOK(w, currentAgentSetup())
	case http.MethodPost:
		var body struct {
			Step string `json:"step"`
		}
		_ = decodeBody(r, &body)
		step := body.Step
		if step == "" {
			step = "rules"
			if !currentAgentSetup().SkillInstalled {
				step = "skill"
			}
		}
		var err error
		switch step {
		case "skill":
			err = installSkill()
		case "rules":
			err = installGlobalRules()
		default:
			writeFail(w, http.StatusBadRequest, "Unknown step '"+step+"'")
			return
		}
		if err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeOK(w, currentAgentSetup())
	default:
		writeFail(w, http.StatusNotFound, "Unknown endpoint "+r.Method+" "+r.URL.Path)
	}
}

// MARK: launch at login

func (s *apiServer) forever(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeOK(w, currentForeverState())
	case http.MethodPost:
		var body struct {
			Enabled bool `json:"enabled"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		st, err := foreverSetFromDaemon(body.Enabled)
		if err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeOK(w, st)
	default:
		writeFail(w, http.StatusNotFound, "Unknown endpoint "+r.Method+" "+r.URL.Path)
	}
}

// MARK: opening the app

func appPathFile() string { return filepath.Join(homeDir(), "app-path.txt") }

// openApp launches the desktop app recorded by its last run, optionally on a
// destination (`server:<id>`, `project:<id>`, `resources`, `ports`).
func openApp(destination *string) (bool, error) {
	data, err := os.ReadFile(appPathFile())
	if err != nil {
		return false, nil
	}
	exe := strings.TrimSpace(string(data))
	if exe == "" || !fileExists(exe) {
		return false, nil
	}
	var args []string
	if destination != nil && *destination != "" {
		args = []string{"--open", *destination}
	}
	self, err := os.Executable()
	if err != nil {
		return true, err
	}
	cmd := exec.Command(self, append([]string{spawnDetachedArg, exe}, args...)...)
	hideWindow(cmd)
	if err := cmd.Run(); err != nil {
		return true, fmt.Errorf("could not start %s: %w", exe, err)
	}
	return true, nil
}

var (
	unixNewline    = string([]byte{10})
	windowsNewline = string([]byte{13, 10})
)
