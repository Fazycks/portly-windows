//go:build !windows

package main

const (
	hostDescription   = "the headless Linux dev server manager"
	foreverSupervisor = "systemd"
	killPortHelp      = "SIGTERM the occupant of a port"
	openHelp          = "Open the Portly app when one is installed"
	foreverHelp       = "Manage the systemd user unit"
	foreverLongHelp   = "Keep Portly available across Linux logins via systemd --user.\nUsage: portly forever enable|status|disable [--json]\n"
)
