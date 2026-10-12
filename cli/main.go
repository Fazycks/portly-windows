package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	defer func() {
		if rec := recover(); rec != nil {
			if code, ok := rec.(quitCode); ok {
				os.Exit(int(code))
				return
			}
			panic(rec)
		}
	}()
	if len(os.Args) > 2 && os.Args[1] == spawnDetachedArg {
		os.Exit(spawnDetached(os.Args[2], os.Args[3:]))
	}
	os.Exit(runCLI(defaultArgs(os.Args[0], os.Args[1:])))
}

// defaultArgs makes a bare `portlyd` (the windowless daemon build that the
// app and Task Scheduler launch) run the supervisor.
func defaultArgs(exe string, args []string) []string {
	name := strings.ToLower(filepath.Base(exe))
	if len(args) == 0 && strings.HasPrefix(name, "portlyd") {
		return []string{"daemon"}
	}
	return args
}

// spawnDetachedArg is an internal entry point: the daemon starts the app
// through a short-lived copy of itself, so the app's parent has already
// exited and a tree kill of the daemon (taskkill /T) never reaches it.
const spawnDetachedArg = "__spawn-detached"

func spawnDetached(exe string, args []string) int {
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	detachDaemon(cmd)
	if err := startDetached(cmd); err != nil {
		return 1
	}
	_ = cmd.Process.Release()
	return 0
}
