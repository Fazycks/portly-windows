//go:build windows

package main

const (
	hostDescription   = "the Windows dev server manager"
	foreverSupervisor = "Task Scheduler"
	killPortHelp      = "Stop the process tree that occupies a port"
	openHelp          = "Open the Portly app"
	foreverHelp       = "Manage the Task Scheduler logon task"
	foreverLongHelp   = "Keep Portly available across Windows logons via a per-user Task Scheduler task (no admin rights).\nUsage: portly forever enable|status|disable [--json]\n"
)
