package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRawOutputOffsetsAndReset(t *testing.T) {
	t.Setenv("PORTLY_HOME", t.TempDir())
	logs := newLogStore("srv_raw", 1000, 1)
	defer logs.close()

	logs.appendBytes([]byte("hello "))
	logs.mu.Lock()
	next, data, reset := logs.rawSinceLocked(0)
	logs.mu.Unlock()
	if string(data) != "hello " || next != 6 || reset {
		t.Fatalf("got %q next=%d reset=%v", data, next, reset)
	}

	// A split UTF-8 character waits for its last byte.
	logs.appendBytes([]byte{0xC3})
	logs.mu.Lock()
	next2, data, _ := logs.rawSinceLocked(next)
	logs.mu.Unlock()
	if len(data) != 0 || next2 != next {
		t.Fatalf("incomplete rune leaked: %q", data)
	}
	logs.appendBytes([]byte{0xA9})
	logs.mu.Lock()
	_, data, _ = logs.rawSinceLocked(next)
	logs.mu.Unlock()
	if string(data) != "é" {
		t.Fatalf("got %q", data)
	}

	logs.clearRaw()
	logs.mu.Lock()
	end, data, reset := logs.rawSinceLocked(8)
	logs.mu.Unlock()
	if len(data) != 0 || reset || end != 8 {
		t.Fatalf("clear should keep offsets: end=%d data=%q reset=%v", end, data, reset)
	}
	logs.mu.Lock()
	_, _, reset = logs.rawSinceLocked(2)
	logs.mu.Unlock()
	if !reset {
		t.Fatal("an offset before the buffer must reset")
	}
}

func TestRawOutputWaitWakesOnAppend(t *testing.T) {
	t.Setenv("PORTLY_HOME", t.TempDir())
	logs := newLogStore("srv_wait", 1000, 1)
	defer logs.close()
	go func() {
		time.Sleep(50 * time.Millisecond)
		logs.appendBytes([]byte("ready"))
	}()
	_, data, _ := logs.waitRaw(0, 5*time.Second, nil)
	if string(data) != "ready" {
		t.Fatalf("got %q", data)
	}
	cancel := make(chan struct{})
	close(cancel)
	start := time.Now()
	if _, data, _ := logs.waitRaw(5, 5*time.Second, cancel); len(data) != 0 || time.Since(start) > time.Second {
		t.Fatal("cancel should return immediately")
	}
}

func TestRawOutputCapsMemory(t *testing.T) {
	t.Setenv("PORTLY_HOME", t.TempDir())
	logs := newLogStore("srv_cap", 1000, 1)
	defer logs.close()
	chunk := []byte(strings.Repeat("x", 1<<20))
	for i := 0; i < 3; i++ {
		logs.appendBytes(chunk)
	}
	logs.mu.Lock()
	defer logs.mu.Unlock()
	if len(logs.raw) != rawOutputLimit || logs.rawBase != 3<<20-rawOutputLimit {
		t.Fatalf("len=%d base=%d", len(logs.raw), logs.rawBase)
	}
}

func TestOriginGuard(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { writeOK(w, "fine") })
	h := withOriginGuard(ok)
	cases := []struct {
		method, origin, host string
		status               int
	}{
		{http.MethodGet, "", "", http.StatusOK},
		{http.MethodGet, "", "localhost:7737", http.StatusOK},
		{http.MethodGet, "", "[::1]:7737", http.StatusOK},
		{http.MethodGet, "http://tauri.localhost", "", http.StatusOK},
		{http.MethodOptions, "http://tauri.localhost", "", http.StatusNoContent},
		{http.MethodPost, "https://evil.example", "", http.StatusForbidden},
		{http.MethodOptions, "http://localhost:3000", "", http.StatusForbidden},
		// The Vite dev server is trusted only with PORTLY_DEV_ORIGIN=1.
		{http.MethodGet, "http://localhost:1420", "", http.StatusForbidden},
		// DNS rebinding: a same-origin GET carries no Origin, only a foreign Host.
		{http.MethodGet, "", "rebind.evil.example:7737", http.StatusForbidden},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, "/status", nil)
		req.Host = "127.0.0.1:7737"
		if c.host != "" {
			req.Host = c.host
		}
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != c.status {
			t.Fatalf("%s from %q: got %d want %d", c.method, c.origin, rec.Code, c.status)
		}
		if c.status != http.StatusForbidden && c.origin != "" && rec.Header().Get("Access-Control-Allow-Origin") != c.origin {
			t.Fatalf("missing CORS header for %q", c.origin)
		}
	}
}

func writeTestFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDetectNodeScriptsAndPorts(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "package.json"), `{
		"scripts": {"dev": "next dev", "start": "node server.js --port 4100", "build": "next build", "dev:api": "tsx api.ts"},
		"dependencies": {"next": "15"}
	}`)
	writeTestFile(t, filepath.Join(dir, "pnpm-lock.yaml"), "")
	got := detectCommands(dir, map[int]bool{3000: true})
	if len(got) != 3 {
		t.Fatalf("got %+v", got)
	}
	if got[0].Command != "pnpm dev -- --port 3001" && !strings.HasPrefix(got[0].Command, "pnpm dev -- --port ") {
		t.Fatalf("reserved framework port should move: %+v", got[0])
	}
	if got[0].Port == nil || *got[0].Port == 3000 {
		t.Fatalf("port should skip the reserved 3000: %+v", got[0])
	}
	if got[1].Name != "start" || got[1].Port == nil || (*got[1].Port != 4100 && strings.Contains(got[1].Command, "-- --port")) {
		t.Fatalf("explicit port must not get a port argument: %+v", got[1])
	}
	if got[2].Name != "dev-api" || got[2].Source != "package.json" {
		t.Fatalf("namespaced script: %+v", got[2])
	}
}

func TestDetectMonorepoAndOtherStacks(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n")
	writeTestFile(t, filepath.Join(dir, "pnpm-lock.yaml"), "")
	writeTestFile(t, filepath.Join(dir, "apps", "web", "package.json"), `{"scripts":{"dev":"vite"},"devDependencies":{"vite":"5"}}`)
	writeTestFile(t, filepath.Join(dir, "apps", "web", ".env"), "PORT=5999\n")
	writeTestFile(t, filepath.Join(dir, "go.mod"), "module x\n")
	got := detectCommands(dir, nil)
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	web := got[0]
	if web.Name != "web" || web.Command != "pnpm dev" || web.Directory == nil || *web.Directory != "apps/web" || web.Source != "apps/web/package.json" {
		t.Fatalf("workspace app: %+v", web)
	}
	if web.Port == nil || *web.Port < 5999 {
		t.Fatalf(".env port: %+v", web.Port)
	}
	if got[1].Command != "go run ." {
		t.Fatalf("go stack: %+v", got[1])
	}
	if len(detectCommands(filepath.Join(dir, "missing"), nil)) != 0 {
		t.Fatal("missing folder should yield nothing")
	}
}

func TestPortFromScript(t *testing.T) {
	cases := map[string]int{
		"PORT=${PORT:-4000} node x": 4000,
		"vite --port=5174":          5174,
		"next dev -p 3005":          3005,
		"PORT 8080 node x":          8080,
	}
	for script, want := range cases {
		if got := portFromScript(script); got == nil || *got != want {
			t.Fatalf("%q: got %v want %d", script, got, want)
		}
	}
	if portFromScript("node server.js") != nil {
		t.Fatal("no port expected")
	}
}

func TestManagedRuleInstallIsIdempotent(t *testing.T) {
	once := installManagedRule("# Mine\nkeep me")
	if !strings.HasPrefix(once, "# Mine\nkeep me\n\n"+managedRuleStart) || !strings.HasSuffix(once, managedRuleEnd+"\n") {
		t.Fatalf("append layout:\n%s", once)
	}
	if installManagedRule(once) != once {
		t.Fatal("reinstalling must not change the file")
	}
	stale := "a\n" + managedRuleStart + "\nold rule\n" + managedRuleEnd + "\nb\n"
	updated := installManagedRule(stale)
	if !strings.HasPrefix(updated, "a\n"+managedRuleStart) || !strings.HasSuffix(updated, managedRuleEnd+"\nb\n") || strings.Contains(updated, "old rule") {
		t.Fatalf("replace in place:\n%s", updated)
	}
	if !strings.Contains(updated, "exits with code `124`") {
		t.Fatal("rule must keep the marker the installed check looks for")
	}
}

func TestAgentSetupInstallsIntoHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	if st := currentAgentSetup(); st.SkillInstalled || st.Complete {
		t.Fatalf("fresh home: %+v", st)
	}
	if err := installSkill(); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"SKILL.md", filepath.Join("agents", "openai.yaml")} {
		if !fileExists(filepath.Join(home, ".agents", "skills", "portly", rel)) {
			t.Fatalf("missing %s", rel)
		}
	}
	writeTestFile(t, filepath.Join(home, ".claude", "CLAUDE.md"), "# My rules\n")
	if err := installGlobalRules(); err != nil {
		t.Fatal(err)
	}
	st := currentAgentSetup()
	if !st.SkillInstalled || !st.AgentsRulesInstalled || !st.ClaudeRulesInstalled || !st.Complete {
		t.Fatalf("after install: %+v", st)
	}
	data, _ := os.ReadFile(filepath.Join(home, ".claude", "CLAUDE.md"))
	if !strings.HasPrefix(string(data), "# My rules\n\n") {
		t.Fatalf("existing rules must be kept:\n%s", data)
	}
}

func TestMigrateLegacyConfigKeepsProjectsOnly(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "old.json")
	target := filepath.Join(dir, "new", "config.json")
	writeTestFile(t, legacy, `{"version":1,"apiPort":9999,"logBufferLines":42,"projects":[
		{"id":"prj_1","name":"App","root":"C:/app","servers":[{"id":"srv_1","name":"web","command":"pnpm dev"},{"id":"srv_2","name":"bad","command":""}]},
		{"id":"prj_2","name":"broken"}]}`)
	t.Setenv("PORTLY_HOME", filepath.Join(dir, "new"))
	if !migrateConfigFrom(legacy, target) {
		t.Fatal("expected a migration")
	}
	cfg, ok := readConfig(target)
	if !ok || len(cfg.Projects) != 1 || len(cfg.Projects[0].Servers) != 1 {
		t.Fatalf("got %+v", cfg)
	}
	if cfg.APIPort != defaultAPIPort || cfg.LogBufferLines == 42 {
		t.Fatal("settings must not be imported")
	}
	if cfg.Projects[0].Icon == "" || cfg.Projects[0].MemoryLimitMode != MemoryInherit {
		t.Fatalf("defaults not filled: %+v", cfg.Projects[0])
	}
	if migrateConfigFrom(legacy, target) {
		t.Fatal("an existing config must never be overwritten")
	}
}

func TestDevLauncherDetection(t *testing.T) {
	yes := []string{
		`"C:\Program Files\nodejs\node.exe" C:\Users\me\AppData\Roaming\npm\node_modules\pnpm\bin\pnpm.cjs dev`,
		"npm run dev",
		`node C:\app\node_modules\next\dist\bin\next dev`,
		"node /app/node_modules/.bin/vite",
	}
	for _, line := range yes {
		if !isDevLauncher(line) {
			t.Fatalf("%q should be a dev launcher", line)
		}
	}
	for _, line := range []string{"node server.js", "Code Helper vite", "invite.exe"} {
		if isDevLauncher(line) {
			t.Fatalf("%q is not a dev launcher", line)
		}
	}
}

func TestTerminationTargetPicksOutermostLauncher(t *testing.T) {
	self := os.Getpid()
	table := processTable{self: self, owner: map[int]string{}, sameUser: func(int) bool { return true }, records: map[int]procRecord{
		100: {PID: 100, ParentPID: 90, Command: "node"},
		90:  {PID: 90, ParentPID: 80, Command: "node"},
		80:  {PID: 80, ParentPID: 70, Command: "node"},
		70:  {PID: 70, ParentPID: 4, Command: "explorer"},
	}}
	lines := map[int]string{100: "node worker.js", 90: "node next dev", 80: "node pnpm.cjs dev", 70: "explorer.exe"}
	if got := table.terminationTarget(100, func(pid int) string { return lines[pid] }); got != 80 {
		t.Fatalf("got %d, want the pnpm launcher", got)
	}
	table.owner[80] = "srv_managed"
	if got := table.terminationTarget(100, func(pid int) string { return lines[pid] }); got != 90 {
		t.Fatalf("got %d, must stop below a managed server", got)
	}
}

// Bytes captured from a real `npm run dev` under ConPTY: lines are separated
// by cursor moves, and the terminal is cleared and homed first.
func TestIngestSplitsConPTYCursorMoves(t *testing.T) {
	t.Setenv("PORTLY_HOME", t.TempDir())
	s := newLogStore("srv_conpty", 100, 1)
	defer s.close()
	raw := "\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;npm\x07\x1b[?25h\r\n> dev\r\n> node server.js\x1b[5;1H\x1b[?25hlistening on\x1b[3Chttp://127.0.0.1:5199\r\n"
	// Feed byte by byte so sequences straddle chunk boundaries.
	for i := 0; i < len(raw); i++ {
		s.ingest(raw[i : i+1])
	}
	got := s.tail(10)
	want := []string{"", "> dev", "> node server.js", "listening on   http://127.0.0.1:5199"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestManagedRuleKeepsTextAfterOrphanStart(t *testing.T) {
	orphan := "a\n" + managedRuleStart + "\nmine\n" + managedRuleStart + "\nold rule\n" + managedRuleEnd + "\n"
	updated := installManagedRule(orphan)
	if !strings.Contains(updated, "\nmine\n") || strings.Contains(updated, "old rule") {
		t.Fatalf("user text between markers must survive:\n%s", updated)
	}
}
