//go:build windows

package main

import (
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
)

// The daemon runs as a per-user Task Scheduler task started at logon. Tasks
// in the root folder that run as the current user need no admin rights.
const foreverTaskName = "Portly Forever"

func foreverDaemonExecutable() string {
	exe, _ := os.Executable()
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	if sibling := filepath.Join(filepath.Dir(exe), "portlyd.exe"); fileExists(sibling) {
		return sibling
	}
	return exe
}

func xmlEscape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func foreverTaskXML(exe, userID string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Portly headless supervisor: keeps your local development servers running.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>%[2]s</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>%[2]s</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%[1]s</Command>
      <Arguments>daemon</Arguments>
    </Exec>
  </Actions>
</Task>
`, xmlEscape(exe), xmlEscape(userID))
}

func currentUserID() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	domain := os.Getenv("USERDOMAIN")
	name := os.Getenv("USERNAME")
	if domain != "" {
		return domain + `\` + name
	}
	return name
}

func runSchtasks(args ...string) (string, error) {
	cmd := exec.Command("schtasks", args...)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("schtasks %s failed: %s", args[0], strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func foreverTaskExists() bool {
	_, err := runSchtasks("/Query", "/TN", foreverTaskName)
	return err == nil
}

func currentForeverState() foreverState {
	st := foreverState{
		Label:            foreverTaskName,
		Unit:             `Task Scheduler \` + foreverTaskName,
		DaemonExecutable: foreverDaemonExecutable(),
	}
	out, err := runSchtasks("/Query", "/TN", foreverTaskName, "/FO", "LIST")
	if err != nil {
		return st
	}
	st.Enabled = true
	st.Loaded = strings.Contains(strings.ToLower(out), "running") || strings.Contains(strings.ToLower(out), "en cours")
	if !st.Loaded {
		st.Loaded = newClient(0).reachable(500 * time.Millisecond)
	}
	return st
}

func foreverEnable(c *portlyClient) (foreverState, error) {
	exe := foreverDaemonExecutable()
	active := snapshotActiveServers(c)
	if c.reachable(time.Second) {
		_ = c.request("POST", "quit", map[string]any{}, &actionResponse{}, false)
		waitUntilUnreachable(c)
	}
	dir, err := os.MkdirTemp("", "portly-task-")
	if err != nil {
		return foreverState{}, err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "task.xml")
	if err := os.WriteFile(path, utf16LEWithBOM(foreverTaskXML(exe, currentUserID())), 0o600); err != nil {
		return foreverState{}, err
	}
	if _, err := runSchtasks("/Create", "/TN", foreverTaskName, "/XML", path, "/F"); err != nil {
		return foreverState{}, err
	}
	if _, err := runSchtasks("/Run", "/TN", foreverTaskName); err != nil {
		return foreverState{}, err
	}
	if !waitForAPI(c) {
		return foreverState{}, fmt.Errorf("Task Scheduler started Portly, but its control API did not become reachable")
	}
	restoreServers(c, active)
	return currentForeverState(), nil
}

func foreverDisable(c *portlyClient) (foreverState, error) {
	if !foreverTaskExists() {
		return currentForeverState(), nil
	}
	active := snapshotActiveServers(c)
	// Deleting the task leaves the running daemon alone; it keeps serving
	// until the user quits Portly, like `launchctl bootout` + relaunch.
	if _, err := runSchtasks("/Delete", "/TN", foreverTaskName, "/F"); err != nil {
		return foreverState{}, err
	}
	if len(active) > 0 && !c.reachable(time.Second) {
		if err := c.launchDaemonIfNeeded(); err != nil {
			return foreverState{}, fmt.Errorf("Launch at login was disabled, but Portly could not be relaunched")
		}
		restoreServers(c, active)
	}
	return currentForeverState(), nil
}

func utf16LEWithBOM(s string) []byte {
	units := utf16.Encode([]rune(s))
	out := make([]byte, 2, 2+len(units)*2)
	out[0], out[1] = 0xFF, 0xFE
	for _, u := range units {
		out = append(out, byte(u), byte(u>>8))
	}
	return out
}

// foreverSetFromDaemon toggles launch at login from inside the running
// daemon (Settings in the app). Unlike the CLI path it never restarts the
// daemon: the task only matters at the next logon.
func foreverSetFromDaemon(enabled bool) (foreverState, error) {
	if !enabled {
		if foreverTaskExists() {
			if _, err := runSchtasks("/Delete", "/TN", foreverTaskName, "/F"); err != nil {
				return foreverState{}, err
			}
		}
		return currentForeverState(), nil
	}
	dir, err := os.MkdirTemp("", "portly-task-")
	if err != nil {
		return foreverState{}, err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "task.xml")
	if err := os.WriteFile(path, utf16LEWithBOM(foreverTaskXML(foreverDaemonExecutable(), currentUserID())), 0o600); err != nil {
		return foreverState{}, err
	}
	if _, err := runSchtasks("/Create", "/TN", foreverTaskName, "/XML", path, "/F"); err != nil {
		return foreverState{}, err
	}
	return currentForeverState(), nil
}
