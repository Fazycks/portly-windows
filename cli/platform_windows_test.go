//go:build windows

package main

import (
	"os"
	"strings"
	"testing"
)

const (
	testEchoExit3 = "echo hello-portly& exit /b 3"
	testPython    = "python"
	testSleep     = "ping -n 31 127.0.0.1 >nul"
)

func TestChildEnvOverrideReplacesPathCaseInsensitively(t *testing.T) {
	t.Setenv("Path", `C:\inherited`)
	env := childEnv(nil, "web", nil, map[string]string{"PATH": `C:\override`})
	var found []string
	for _, kv := range env {
		if strings.EqualFold(kv[:min(5, len(kv))], "PATH=") {
			found = append(found, kv)
		}
	}
	if len(found) != 1 || found[0] != `PATH=C:\override` {
		t.Fatalf("PATH entries = %q, want only the override", found)
	}
}

func TestSameUserProcessUsesTokenUser(t *testing.T) {
	if !sameUserProcess(os.Getppid()) {
		t.Fatal("the test's parent runs as the same user")
	}
	for _, rec := range listProcesses() {
		if strings.EqualFold(rec.Command, "dwm") || strings.EqualFold(rec.Command, "csrss") {
			if sameUserProcess(rec.PID) {
				t.Fatalf("%s (pid %d) must not count as the user's process", rec.Command, rec.PID)
			}
		}
	}
}
