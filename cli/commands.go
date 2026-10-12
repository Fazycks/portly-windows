package main

import (
	"flag"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type globalOpts struct {
	JSON    bool
	APIPort int
}

func parseFlexible(fs *flag.FlagSet, args []string) error {
	var flags, pos []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			pos = append(pos, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			pos = append(pos, arg)
			continue
		}
		name := strings.TrimLeft(arg, "-")
		name, _, _ = strings.Cut(name, "=")
		flags = append(flags, arg)
		if strings.Contains(arg, "=") {
			continue
		}
		if f := fs.Lookup(name); f != nil && !isBoolFlag(f) && i+1 < len(args) {
			i++
			flags = append(flags, args[i])
		}
	}
	return fs.Parse(append(flags, pos...))
}

func isBoolFlag(f *flag.Flag) bool {
	type boolFlag interface{ IsBoolFlag() bool }
	bf, ok := f.Value.(boolFlag)
	return ok && bf.IsBoolFlag()
}

func extractGlobal(args []string) (globalOpts, []string) {
	var g globalOpts
	var out []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--json":
			g.JSON = true
		case arg == "--api-port" && i+1 < len(args):
			i++
			g.APIPort, _ = strconv.Atoi(args[i])
		case strings.HasPrefix(arg, "--api-port="):
			g.APIPort, _ = strconv.Atoi(strings.TrimPrefix(arg, "--api-port="))
		default:
			out = append(out, arg)
		}
	}
	return g, out
}

func runCLI(args []string) int {
	if hasHelp(args) && (len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help") {
		fmt.Print(rootHelp)
		return 0
	}
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-v") {
		fmt.Println(portlyVersion)
		return 0
	}
	g, args := extractGlobal(args)
	if len(args) == 0 {
		args = []string{"status"}
	}
	cmd := args[0]
	rest := args[1:]
	if hasHelp(rest) {
		fmt.Print(commandHelp(cmd))
		return 0
	}
	switch cmd {
	case "status", "list", "ls":
		return cmdStatus(g, rest)
	case "start":
		return cmdTarget(g, rest, "start", false)
	case "stop":
		return cmdStop(g, rest)
	case "restart":
		return cmdTarget(g, rest, "restart", false)
	case "action":
		return cmdAction(g, rest)
	case "logs":
		return cmdLogs(g, rest)
	case "temp", "temporary", "run-temp":
		return cmdTemp(g, rest)
	case "wait":
		return cmdWait(g, rest)
	case "add-project":
		return cmdAddProject(g, rest)
	case "add-server":
		return cmdAddServer(g, rest)
	case "update-server":
		return cmdUpdateServer(g, rest)
	case "memory-limit", "ram-limit":
		return cmdMemoryLimit(g, rest)
	case "idle-timeout", "idle":
		return cmdIdleTimeout(g, rest)
	case "remove":
		return cmdRemove(g, rest)
	case "take-over", "adopt":
		return cmdTakeOver(g, rest)
	case "port":
		return cmdPort(g, rest)
	case "kill-port":
		return cmdKillPort(g, rest)
	case "open":
		return cmdOpen(g, rest)
	case "quit":
		return cmdQuit(g)
	case "forever":
		return cmdForever(g, rest)
	case "config":
		return cmdConfig(rest)
	case "daemon":
		fs := flag.NewFlagSet("daemon", flag.ContinueOnError)
		port := fs.Int("api-port", 0, "control API port")
		_ = parseFlexible(fs, rest)
		if g.APIPort != 0 {
			*port = g.APIPort
		}
		if err := runDaemon(*port); err != nil {
			fail(err.Error())
		}
		return 0
	default:
		fail("Unknown command '" + cmd + "'. Run portly --help.")
		return 1
	}
}

func hasHelp(args []string) bool {
	for _, a := range args {
		if a == "--help" || a == "-h" {
			return true
		}
	}
	return false
}

func cmdStatus(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	details := fs.Bool("details", false, "full inventory")
	_ = parseFlexible(fs, args)
	c := newClient(g.APIPort)
	var status PortlyStatus
	if err := c.get("status", &status); err != nil {
		fail(err.Error())
	}
	emit(status, g.JSON, func() string {
		if *details {
			return renderDetailed(status)
		}
		return renderCompact(status)
	})
	return 0
}

func cmdTarget(g globalOpts, args []string, verb string, allowEmpty bool) int {
	fs := flag.NewFlagSet(verb, flag.ExitOnError)
	project := fs.String("project", "", "project")
	_ = parseFlexible(fs, args)
	server := ""
	if fs.NArg() > 0 {
		server = fs.Arg(0)
	}
	if server == "" && *project == "" && !allowEmpty {
		fail("Pass a server name, or --project <name>.")
	}
	body := targetRequest{}
	if server != "" {
		body.Server = &server
	}
	if *project != "" {
		body.Project = project
	}
	var resp actionResponse
	if err := newClient(g.APIPort).post(verb, body, &resp); err != nil {
		fail(err.Error())
	}
	emit(resp, g.JSON, func() string { return resp.Message })
	return 0
}

func cmdStop(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("stop", flag.ExitOnError)
	project := fs.String("project", "", "project")
	all := fs.Bool("all", false, "stop everything")
	_ = parseFlexible(fs, args)
	server := ""
	if fs.NArg() > 0 {
		server = fs.Arg(0)
	}
	if !*all && server == "" && *project == "" {
		fail("Pass a server name, --project <name>, or --all.")
	}
	body := targetRequest{}
	if server != "" {
		body.Server = &server
	}
	if *project != "" {
		body.Project = project
	}
	var resp actionResponse
	if err := newClient(g.APIPort).post("stop", body, &resp); err != nil {
		fail(err.Error())
	}
	emit(resp, g.JSON, func() string { return resp.Message })
	return 0
}

func cmdAction(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("action", flag.ExitOnError)
	timeout := fs.String("timeout", "30m", "maximum runtime")
	_ = parseFlexible(fs, args)
	if fs.NArg() < 2 {
		fail("Pass a server and an action name.")
	}
	seconds, ok := parseTimeout(*timeout)
	if !ok {
		fail("Bad --timeout '" + *timeout + "'. Use 30s, 10m, 2h, or seconds up to 7 days")
	}
	body := runActionRequest{Server: fs.Arg(0), Action: fs.Arg(1), TimeoutSeconds: &seconds}
	var job TemporaryJobStatus
	if err := newClient(g.APIPort).post("actions/run", body, &job); err != nil {
		fail(err.Error())
	}
	emit(job, g.JSON, func() string { return job.ID })
	return 0
}

func cmdLogs(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("logs", flag.ExitOnError)
	tail := fs.Int("tail", 200, "lines")
	fs.IntVar(tail, "t", 200, "lines")
	_ = parseFlexible(fs, args)
	if fs.NArg() < 1 {
		fail("Pass a server name.")
	}
	escaped := url.QueryEscape(fs.Arg(0))
	var resp logsResponse
	if err := newClient(g.APIPort).get(fmt.Sprintf("logs?server=%s&tail=%d", escaped, *tail), &resp); err != nil {
		fail(err.Error())
	}
	emit(resp, g.JSON, func() string { return strings.Join(resp.Lines, "\n") })
	return 0
}

func cmdTemp(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("temp", flag.ExitOnError)
	name := fs.String("name", "", "label")
	commandOpt := fs.String("command", "", "command")
	path := fs.String("path", "", "working directory")
	port := fs.Int("port", 0, "port")
	health := fs.String("health-url", "", "health URL")
	timeout := fs.String("timeout", "30m", "timeout")
	var env []string
	fs.Func("env", "KEY=VALUE", func(v string) error { env = append(env, v); return nil })
	_ = parseFlexible(fs, args)
	command := ""
	if fs.NArg() > 0 {
		command = fs.Arg(0)
	}
	if command != "" && *commandOpt != "" {
		fail("Pass the command either positionally or with --command, not both")
	}
	if command == "" {
		command = *commandOpt
	}
	command = strings.TrimSpace(command)
	if command == "" {
		fail("Missing command. Example: portly temp 'npm run build'")
	}
	seconds, ok := parseTimeout(*timeout)
	if !ok {
		fail("Bad --timeout '" + *timeout + "'. Use 30s, 10m, 2h, or seconds up to 7 days")
	}
	selectedName := strings.TrimSpace(*name)
	if selectedName == "" {
		parts := strings.Fields(command)
		if len(parts) > 4 {
			parts = parts[:4]
		}
		selectedName = strings.Join(parts, " ")
	}
	parsedEnv := map[string]string{}
	for _, entry := range env {
		k, v, ok := strings.Cut(entry, "=")
		if !ok {
			fail("Bad --env value '" + entry + "', expected KEY=VALUE")
		}
		parsedEnv[k] = v
	}
	dir := *path
	if dir == "" {
		dir, _ = os.Getwd()
	}
	body := runTemporaryRequest{
		Name:           selectedName,
		Command:        command,
		Directory:      dir,
		TimeoutSeconds: &seconds,
	}
	if *port != 0 {
		body.Port = port
	}
	if *health != "" {
		body.HealthURL = health
	}
	if len(parsedEnv) > 0 {
		body.Env = parsedEnv
	}
	var job TemporaryJobStatus
	if err := newClient(g.APIPort).post("temporary/run", body, &job); err != nil {
		fail(err.Error())
	}
	emit(job, g.JSON, func() string { return job.ID })
	return 0
}

func cmdWait(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("wait", flag.ExitOnError)
	tail := fs.Int("tail", 500, "log lines")
	noLogs := fs.Bool("no-logs", false, "skip logs")
	_ = parseFlexible(fs, args)
	if fs.NArg() < 1 {
		fail("Pass a temporary job ID.")
	}
	id := fs.Arg(0)
	escaped := url.QueryEscape(id)
	c := newClient(g.APIPort)
	var job TemporaryJobStatus
	if err := c.get("temporary/status?id="+escaped, &job); err != nil {
		fail(err.Error())
	}
	for !job.State.isFinished() {
		time.Sleep(250 * time.Millisecond)
		if err := c.get("temporary/status?id="+escaped, &job); err != nil {
			fail(err.Error())
		}
	}
	if g.JSON {
		emit(job, true, func() string { return "" })
	} else {
		if !*noLogs {
			time.Sleep(100 * time.Millisecond)
			count := *tail
			if count < 1 {
				count = 1
			}
			if count > 5000 {
				count = 5000
			}
			var logs logsResponse
			if err := c.get(fmt.Sprintf("logs?server=%s&tail=%d", escaped, count), &logs); err == nil && len(logs.Lines) > 0 {
				fmt.Println(strings.Join(logs.Lines, "\n"))
			}
		}
		fmt.Println(jobSummary(job))
	}
	os.Exit(job.processExitCode())
	return job.processExitCode()
}

func cmdAddProject(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("add-project", flag.ExitOnError)
	name := fs.String("name", "", "name")
	path := fs.String("path", "", "path")
	icon := fs.String("icon", "", "icon")
	color := fs.String("color", "", "color")
	memory := fs.String("memory-limit", "", "memory policy")
	_ = parseFlexible(fs, args)
	if *name == "" || *path == "" {
		fail("Pass --name and --path.")
	}
	body := addProjectRequest{Name: *name, Root: *path}
	if *icon != "" {
		body.Icon = icon
	}
	if *color != "" {
		body.Color = color
	}
	if *memory != "" {
		mode, bytes := parseMemoryLimit(*memory, true)
		body.MemoryLimitMode = &mode
		body.MemoryLimitBytes = bytes
	}
	var project Project
	if err := newClient(g.APIPort).post("projects/add", body, &project); err != nil {
		fail(err.Error())
	}
	emit(project, g.JSON, func() string { return fmt.Sprintf("Added project %s (%s)", project.Name, project.ID) })
	return 0
}

func cmdAddServer(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("add-server", flag.ExitOnError)
	project := fs.String("project", "", "project")
	name := fs.String("name", "", "name")
	command := fs.String("command", "", "command")
	port := fs.Int("port", 0, "port")
	directory := fs.String("directory", "", "directory")
	health := fs.String("health-url", "", "health URL")
	autoRestart := true
	fs.BoolFunc("auto-restart", "restart after crash", func(s string) error {
		autoRestart = s != "false"
		return nil
	})
	fs.BoolFunc("no-auto-restart", "leave a crash stopped", func(string) error {
		autoRestart = false
		return nil
	})
	start := fs.Bool("start", false, "start immediately")
	idle := fs.String("idle-timeout", "", "idle timeout: duration, off, or inherit")
	var env []string
	var actions []string
	fs.Func("env", "KEY=VALUE", func(v string) error { env = append(env, v); return nil })
	fs.Func("action", "NAME=COMMAND", func(v string) error { actions = append(actions, v); return nil })
	_ = parseFlexible(fs, args)
	if *project == "" || *name == "" || *command == "" {
		fail("Pass --project, --name, and --command.")
	}
	var idleSeconds *int
	if *idle != "" {
		parsed, err := parseIdleTimeout(*idle, true)
		if err != nil {
			fail(err.Error())
		}
		idleSeconds = parsed
	}
	parsedEnv := map[string]string{}
	for _, entry := range env {
		k, v, ok := strings.Cut(entry, "=")
		if !ok {
			fail("Bad --env value '" + entry + "', expected KEY=VALUE")
		}
		parsedEnv[k] = v
	}
	body := addServerRequest{
		Project:     *project,
		Name:        *name,
		Command:     *command,
		AutoRestart: &autoRestart,
		Start:       start,
		Actions:     parseServerActions(actions),

		IdleTimeoutSeconds: idleSeconds,
	}
	if *port != 0 {
		body.Port = port
	}
	if *directory != "" {
		body.Directory = directory
	}
	if *health != "" {
		body.HealthURL = health
	}
	if len(parsedEnv) > 0 {
		body.Env = parsedEnv
	}
	var server ServerConfig
	if err := newClient(g.APIPort).post("servers/add", body, &server); err != nil {
		fail(err.Error())
	}
	emit(server, g.JSON, func() string { return fmt.Sprintf("Added server %s (%s)", server.Name, server.ID) })
	return 0
}

func cmdUpdateServer(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("update-server", flag.ExitOnError)
	name := fs.String("name", "", "name")
	command := fs.String("command", "", "command")
	port := fs.Int("port", 0, "port")
	directory := fs.String("directory", "", "directory")
	health := fs.String("health-url", "", "health URL")
	clearActions := fs.Bool("clear-actions", false, "remove actions")
	var autoRestart *bool
	fs.BoolFunc("auto-restart", "restart after crash", func(s string) error {
		v := s != "false"
		autoRestart = &v
		return nil
	})
	fs.BoolFunc("no-auto-restart", "leave a crash stopped", func(string) error {
		v := false
		autoRestart = &v
		return nil
	})
	var actions []string
	fs.Func("action", "NAME=COMMAND", func(v string) error { actions = append(actions, v); return nil })
	_ = parseFlexible(fs, args)
	if fs.NArg() < 1 {
		fail("Pass a server name.")
	}
	if len(actions) > 0 && *clearActions {
		fail("Pass --action values or --clear-actions, not both")
	}
	body := updateServerRequest{Server: fs.Arg(0)}
	if *name != "" {
		body.Name = name
	}
	if *command != "" {
		body.Command = command
	}
	if *port != 0 {
		body.Port = port
	}
	if *directory != "" {
		body.Directory = directory
	}
	if *health != "" {
		body.HealthURL = health
	}
	body.AutoRestart = autoRestart
	if *clearActions {
		body.Actions = []ServerAction{}
	} else if len(actions) > 0 {
		body.Actions = parseServerActions(actions)
	}
	var server ServerConfig
	if err := newClient(g.APIPort).post("servers/update", body, &server); err != nil {
		fail(err.Error())
	}
	emit(server, g.JSON, func() string { return "Updated " + server.Name })
	return 0
}

func cmdMemoryLimit(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("memory-limit", flag.ExitOnError)
	project := fs.String("project", "", "project")
	_ = parseFlexible(fs, args)
	c := newClient(g.APIPort)
	if fs.NArg() == 0 {
		var status PortlyStatus
		if err := c.get("status", &status); err != nil {
			fail(err.Error())
		}
		emit(status, g.JSON, func() string { return renderMemoryLimits(status) })
		return 0
	}
	mode, bytes := parseMemoryLimit(fs.Arg(0), *project != "")
	body := updateMemoryLimitRequest{Mode: mode, Bytes: bytes}
	if *project != "" {
		body.Project = project
	}
	var resp actionResponse
	if err := c.post("memory-limit", body, &resp); err != nil {
		fail(err.Error())
	}
	emit(resp, g.JSON, func() string { return resp.Message })
	return 0
}

func cmdIdleTimeout(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("idle-timeout", flag.ExitOnError)
	server := fs.String("server", "", "server")
	_ = parseFlexible(fs, args)
	c := newClient(g.APIPort)
	if fs.NArg() == 0 {
		var status PortlyStatus
		if err := c.get("status", &status); err != nil {
			fail(err.Error())
		}
		emit(status, g.JSON, func() string { return renderIdleTimeouts(status) })
		return 0
	}
	seconds, err := parseIdleTimeout(fs.Arg(0), *server != "")
	if err != nil {
		fail(err.Error())
	}
	body := updateIdleTimeoutRequest{Seconds: seconds}
	if *server != "" {
		body.Server = server
	}
	var resp actionResponse
	if err := c.post("idle-timeout", body, &resp); err != nil {
		fail(err.Error())
	}
	emit(resp, g.JSON, func() string { return resp.Message })
	return 0
}

func parseMemoryLimit(raw string, allowInherit bool) (MemoryLimitMode, *uint64) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "off" || value == "disabled" || value == "none" {
		return MemoryDisabled, nil
	}
	if value == "inherit" {
		if !allowInherit {
			fail("The global memory limit cannot inherit; use a size or off")
		}
		return MemoryInherit, nil
	}
	bytes, ok := parseMemorySize(value)
	if !ok {
		fail("Bad memory limit '" + raw + "'. Use a value from 128MB to 1TB, for example 5GB, or use off")
	}
	return MemoryCustom, &bytes
}

func cmdRemove(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("remove", flag.ExitOnError)
	project := fs.String("project", "", "project")
	_ = parseFlexible(fs, args)
	c := newClient(g.APIPort)
	var resp actionResponse
	if *project != "" {
		body := removeRequest{Project: project}
		if err := c.post("projects/remove", body, &resp); err != nil {
			fail(err.Error())
		}
	} else if fs.NArg() > 0 {
		server := fs.Arg(0)
		body := removeRequest{Server: &server}
		if err := c.post("servers/remove", body, &resp); err != nil {
			fail(err.Error())
		}
	} else {
		fail("Pass a server name, or --project <name>.")
	}
	emit(resp, g.JSON, func() string { return resp.Message })
	return 0
}

func cmdTakeOver(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("take-over", flag.ExitOnError)
	_ = parseFlexible(fs, args)
	if fs.NArg() < 1 {
		fail("Pass a server name.")
	}
	var resp actionResponse
	if err := newClient(g.APIPort).post("servers/take-over", takeOverRequest{Server: fs.Arg(0)}, &resp); err != nil {
		fail(err.Error())
	}
	emit(resp, g.JSON, func() string { return resp.Message })
	return 0
}

func cmdPort(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("port", flag.ExitOnError)
	_ = parseFlexible(fs, args)
	if fs.NArg() < 1 {
		fail("Pass a port number.")
	}
	port, err := strconv.Atoi(fs.Arg(0))
	if err != nil {
		fail("Pass a port number.")
	}
	var resp portQueryResponse
	if err := newClient(g.APIPort).get(fmt.Sprintf("ports?port=%d", port), &resp); err != nil {
		fail(err.Error())
	}
	emit(resp, g.JSON, func() string {
		if resp.Occupant == nil {
			return fmt.Sprintf("Port %d is free.", resp.Port)
		}
		owner := ""
		if resp.Occupant.OwnedByPortly {
			owner = " (managed by Portly)"
		}
		return fmt.Sprintf("Port %d: %s pid %d%s", resp.Port, resp.Occupant.Command, resp.Occupant.PID, owner)
	})
	return 0
}

func cmdKillPort(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("kill-port", flag.ExitOnError)
	_ = parseFlexible(fs, args)
	if fs.NArg() < 1 {
		fail("Pass a port number.")
	}
	port, err := strconv.Atoi(fs.Arg(0))
	if err != nil {
		fail("Pass a port number.")
	}
	var resp actionResponse
	if err := newClient(g.APIPort).post("ports/kill", killPortRequest{Port: port}, &resp); err != nil {
		fail(err.Error())
	}
	emit(resp, g.JSON, func() string { return resp.Message })
	return 0
}

func cmdOpen(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("open", flag.ExitOnError)
	resources := fs.Bool("resources", false, "resources")
	ports := fs.Bool("ports", false, "ports")
	_ = parseFlexible(fs, args)
	if *resources && *ports {
		fail("Choose either --resources or --ports")
	}
	var dest *string
	if *resources {
		v := "resources"
		dest = &v
	} else if *ports {
		v := "ports"
		dest = &v
	}
	var resp actionResponse
	if err := newClient(g.APIPort).post("open", openRequest{Destination: dest}, &resp); err != nil {
		fail(err.Error())
	}
	emit(resp, g.JSON, func() string { return resp.Message })
	return 0
}

func cmdQuit(g globalOpts) int {
	var resp actionResponse
	if err := newClient(g.APIPort).request("POST", "quit", map[string]any{}, &resp, false); err != nil {
		fail(err.Error())
	}
	emit(resp, g.JSON, func() string { return resp.Message })
	return 0
}

func cmdForever(g globalOpts, args []string) int {
	sub := "status"
	rest := args
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub = args[0]
		rest = args[1:]
	}
	if hasHelp(rest) || hasHelp([]string{sub}) && (sub == "help") {
		fmt.Print(commandHelp("forever"))
		return 0
	}
	c := newClient(g.APIPort)
	switch sub {
	case "enable":
		state, err := foreverEnable(c)
		if err != nil {
			fail(err.Error())
		}
		emit(state, g.JSON, func() string {
			return "Portly will launch at login and is now supervised by " + foreverSupervisor + "."
		})
	case "disable":
		state, err := foreverDisable(c)
		if err != nil {
			fail(err.Error())
		}
		emit(state, g.JSON, func() string { return "Portly launch at login is disabled." })
	case "status":
		state := currentForeverState()
		emit(state, g.JSON, func() string {
			en := "disabled"
			if state.Enabled {
				en = "enabled"
			}
			loaded := "not loaded"
			if state.Loaded {
				loaded = "loaded"
			}
			return fmt.Sprintf("Launch at login: %s (%s %s)", en, foreverSupervisor, loaded)
		})
	default:
		fail("Unknown forever subcommand '" + sub + "'")
	}
	return 0
}

func cmdConfig(args []string) int {
	fs := flag.NewFlagSet("config", flag.ExitOnError)
	pathOnly := fs.Bool("path-only", false, "path only")
	_ = parseFlexible(fs, args)
	path := configFile()
	if *pathOnly {
		fmt.Println(path)
		return 0
	}
	fmt.Println("# " + path)
	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Println("(not created yet, launch Portly once)")
		return 0
	}
	fmt.Print(string(data))
	return 0
}

func parseServerActions(values []string) []ServerAction {
	seen := map[string]bool{}
	var out []ServerAction
	for _, entry := range values {
		name, command, ok := strings.Cut(entry, "=")
		if !ok {
			fail("Bad --action value '" + entry + "', expected NAME=COMMAND")
		}
		name = strings.TrimSpace(name)
		command = strings.TrimSpace(command)
		if name == "" || command == "" {
			fail("Bad --action value '" + entry + "', name and command cannot be empty")
		}
		if seen[strings.ToLower(name)] {
			fail("Duplicate --action name '" + name + "'")
		}
		seen[strings.ToLower(name)] = true
		out = append(out, ServerAction{Name: name, Command: command})
	}
	return out
}

var rootHelp = `portly - Control Portly, ` + hostDescription + `.

Portly keeps local dev servers running on fixed ports, restarts them when
they crash, and exposes everything through this CLI so an agent can drive it.

Every command starts the Portly daemon if it is not already running.

Usage:
  portly [command]

Commands:
  status, list, ls    Show active servers and problems
  start               Start a server or project
  stop                Stop a server, project, or --all
  restart             Restart a server or project
  action              Run a configured server action
  logs                Print recent server output
  temp                Run a short-lived process
  wait                Wait for a temporary job
  add-project         Register a project folder
  add-server          Add a server to a project
  update-server       Change a server's settings
  memory-limit        Show or set memory guards
  idle-timeout, idle  Show or set automatic stops for inactive servers
  remove              Remove a server or project
  take-over, adopt    Move an external listener under Portly
  port                Show what is listening on a port
  kill-port           ` + killPortHelp + `
  open                ` + openHelp + `
  quit                Stop every server and the daemon
  forever             ` + foreverHelp + `
  config              Print the config file
  daemon              Run the headless supervisor in the foreground

Use "portly <command> --help" for flags. Global flags: --json, --api-port.
`

// commandHelp mirrors the per-command help of the macOS CLI
// (swift-argument-parser), with this port's flag spellings.
func commandHelp(cmd string) string {
	target := "  <server>            Server name or id. Use \"project/server\" to disambiguate.\n" +
		"  --project NAME      Act on every server in this project instead.\n"
	global := "  --json              Print raw JSON instead of a human summary.\n" +
		"  --api-port N        Override the control API port.\n"
	helps := map[string]string{
		"status": "Show active servers and problems compactly.\n\nUsage: portly status [--details] [--json]\n\n" +
			"  --details           Show every configured server, IDs, uptime, and resource metrics.\n" + global,
		"start":   "Start a server, or a whole project.\n\nUsage: portly start <server> | --project NAME\n\n" + target + global,
		"restart": "Restart a server or a project.\n\nUsage: portly restart <server> | --project NAME\n\n" + target + global,
		"stop": "Stop a server, a project, or everything.\n\nUsage: portly stop <server> | --project NAME | --all\n\n" + target +
			"  --all               Stop every server Portly manages.\n" + global,
		"action": "Run a configured server action without restarting the server.\n\nUsage: portly action <server> <action> [--timeout 30m]\n\n" +
			"  <server>            Server name or id. Use project/server to disambiguate.\n" +
			"  <action>            Configured action name, for example clear-cache.\n" +
			"  --timeout DURATION  Maximum runtime, for example 30s, 10m, or 2h.\n" + global,
		"logs": "Print the recent output of a server.\n\nUsage: portly logs <server> [-t|--tail 200]\n\n" +
			"  <server>            Server name or id.\n" +
			"  -t, --tail N        Number of lines to show.\n" + global,
		"temp": "Run a short-lived process without creating a project. Returns a job ID immediately.\n\n" +
			"Usage: portly temp '<command>' [--name NAME] [--path DIR] [--port N] [--health-url URL] [--timeout 30m] [--env KEY=VALUE]...\n\n" +
			"  <command>           Command to run through the shell, for example 'npm run build'.\n" +
			"  --name NAME         Short label shown in Portly. Defaults to the command.\n" +
			"  --command CMD       Command option kept for compatibility; prefer the positional command.\n" +
			"  --path DIR          Working directory. Defaults to the current directory.\n" +
			"  --port N            Optional port to monitor.\n" +
			"  --health-url URL    Optional health check path or URL.\n" +
			"  --timeout DURATION  Maximum runtime: seconds or a value such as 30s, 10m, or 2h.\n" +
			"  --env KEY=VALUE     Environment variable; repeat for several.\n" + global,
		"wait": "Wait for a temporary job and return its exit code.\n\nUsage: portly wait <id> [-t|--tail 500] [--no-logs]\n\n" +
			"  <id>                Temporary job ID returned by 'portly temp'.\n" +
			"  -t, --tail N        Maximum number of captured log lines to print after completion.\n" +
			"  --no-logs           Print only the final result.\n" + global,
		"add-project": "Register a project folder.\n\nUsage: portly add-project --name NAME --path DIR [--icon NAME] [--color HEX] [--memory-limit SIZE]\n\n" +
			"  --name NAME         Project name.\n" +
			"  --path DIR          Absolute path to the project folder.\n" +
			"  --icon NAME         Symbol name shown in the sidebar, for example globe.\n" +
			"  --color HEX         Hex color for the project icon.\n" +
			"  --memory-limit SIZE Project memory policy: inherit, off, or a size such as 5GB.\n" + global,
		"add-server": "Add a server to a project.\n\n" +
			"Usage: portly add-server --project NAME --name NAME --command CMD [--port N] [--directory DIR] [--health-url URL]\n" +
			"                         [--env KEY=VALUE]... [--action NAME=COMMAND]... [--no-auto-restart] [--idle-timeout 30m] [--start]\n\n" +
			"  --project NAME      Project name or id.\n" +
			"  --name NAME         Server name, for example \"web\".\n" +
			"  --command CMD       Command to run, executed through the shell.\n" +
			"  --port N            Port the server listens on.\n" +
			"  --directory DIR     Working directory, relative to the project folder or absolute.\n" +
			"  --health-url URL    Health check path or URL, for example /api/health.\n" +
			"  --env KEY=VALUE     Environment variable; repeat for several.\n" +
			"  --action NAME=CMD   Maintenance action; repeat for several.\n" +
			"  --[no-]auto-restart Restart automatically after a crash (default on).\n" +
			"  --idle-timeout D    Stop after this long without output or CPU activity: a duration such as 30m, off, or inherit (default).\n" +
			"  --start             Start the server right after adding it.\n" + global,
		"update-server": "Change an existing server's settings.\n\n" +
			"Usage: portly update-server <server> [--name NAME] [--command CMD] [--port N] [--directory DIR] [--health-url URL]\n" +
			"                            [--env KEY=VALUE]... [--action NAME=COMMAND]... [--clear-actions] [--[no-]auto-restart]\n\n" +
			"  <server>            Server name or id.\n" +
			"  --action NAME=CMD   Replace maintenance actions with NAME=COMMAND values.\n" +
			"  --clear-actions     Remove every configured action.\n" +
			"  --[no-]auto-restart Restart automatically after a crash.\n" + global,
		"memory-limit": "Show or configure automatic project restarts by memory footprint.\n\nUsage: portly memory-limit [SIZE|off|inherit] [--project NAME]\n\n" +
			"  SIZE                A size such as 5GB/5Go, off, or inherit for a project.\n" +
			"  --project NAME      Project name or ID. Omit to configure the global default.\n" + global,
		"idle-timeout": "Show or configure automatic stops for inactive servers.\n" +
			"Servers that print nothing and stay under 5% CPU for the duration are stopped.\n" +
			"Output answering Portly's own health checks does not count. Temporary jobs keep their own --timeout.\n\n" +
			"Usage: portly idle-timeout [30m|2h|off] [--server project/server]\n\n" +
			"  DURATION            A duration such as 30m or 2h, off, or inherit for a server.\n" +
			"  --server NAME       Server name or id (project/server to disambiguate). Omit to configure the global default.\n" + global,
		"remove": "Remove a server or a project.\n\nUsage: portly remove <server> | --project NAME\n\n" +
			"  <server>            Server name or id.\n" +
			"  --project NAME      Remove a whole project instead.\n" + global,
		"take-over": "Stop an external listener and relaunch the configured server under Portly.\n\nUsage: portly take-over <server>\n\n" +
			"  <server>            Server name or id. Use project/server to disambiguate.\n" + global,
		"port":      "Show what is listening on a port.\n\nUsage: portly port <port>\n\n" + global,
		"kill-port": killPortHelp + ".\n\nUsage: portly kill-port <port>\n\n" + global,
		"open": openHelp + ".\n\nUsage: portly open [--resources | --ports]\n\n" +
			"  --resources         Open the resource and memory dashboard.\n" +
			"  --ports             Open the port inspector.\n" + global,
		"quit":    "Quit Portly, stopping every server.\n\nUsage: portly quit\n\n" + global,
		"forever": foreverLongHelp,
		"config": "Print the config file path and contents.\n\nUsage: portly config [--path-only]\n\n" +
			"  --path-only         Print only the path.\n",
		"daemon": "Run the headless supervisor in the foreground.\nUsage: portly daemon [--api-port 7737]\n",
	}
	helps["list"], helps["ls"] = helps["status"], helps["status"]
	helps["idle"] = helps["idle-timeout"]
	helps["adopt"] = helps["take-over"]
	if h, ok := helps[cmd]; ok {
		return h
	}
	return "See portly --help.\n"
}
