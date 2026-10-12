//go:build !windows

package main

import (
	"strings"
	"testing"
)

func TestForeverUnitIsSystemdUserService(t *testing.T) {
	unit := foreverUnitContents("/usr/local/bin/portly")
	for _, want := range []string{
		"[Unit]",
		"[Service]",
		"[Install]",
		"WantedBy=default.target",
		"ExecStart=/usr/local/bin/portly daemon",
		"WorkingDirectory=%h",
	} {
		if !strings.Contains(unit, want) {
			t.Fatalf("missing %q in:\n%s", want, unit)
		}
	}
	if strings.Contains(unit, "LaunchAgents") || strings.Contains(unit, "launchctl") {
		t.Fatal(unit)
	}
}
