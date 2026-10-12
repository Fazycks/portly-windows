package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
)

// childEnv builds a server's environment. On Windows variable names are
// case-insensitive, so the inherited "Path" and an override named "PATH" are
// the same variable: the override must replace it, not sit beside it.
func childEnv(base map[string]string, server string, port *int, extra map[string]string) []string {
	type entry struct{ name, value string }
	envMap := map[string]entry{}
	key := func(name string) string {
		if runtime.GOOS == "windows" {
			return strings.ToUpper(name)
		}
		return name
	}
	set := func(name, value string) { envMap[key(name)] = entry{name, value} }
	for _, kv := range os.Environ() {
		if i := indexByte([]byte(kv[min(1, len(kv)):]), '='); i >= 0 {
			set(kv[:i+1], kv[i+2:])
		}
	}
	delete(envMap, key("NO_COLOR"))
	set("TERM", "xterm-256color")
	set("COLORTERM", "truecolor")
	set("FORCE_COLOR", "1")
	set("CLICOLOR", "1")
	set("CLICOLOR_FORCE", "1")
	set("TERM_PROGRAM", "Portly")
	set("PORTLY", "1")
	set("PORTLY_SERVER", server)
	if port != nil {
		set("PORT", fmt.Sprintf("%d", *port))
	}
	for k, v := range extra {
		set(k, v)
	}
	out := make([]string, 0, len(envMap))
	for _, e := range envMap {
		out = append(out, e.name+"="+e.value)
	}
	sort.Strings(out)
	return out
}

// helperCommand runs a short-lived helper tool without flashing a console
// window on Windows (the daemon has none of its own).
func helperCommand(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	hideWindow(cmd)
	return cmd
}
