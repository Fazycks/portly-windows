//go:build windows

package main

import (
	"os/exec"
	"testing"

	"golang.org/x/sys/windows"
)

func TestJobProcessIDsListsMembers(t *testing.T) {
	job, err := newKillOnCloseJob()
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(job)
	cmd := exec.Command("ping.exe", "-n", "30", "127.0.0.1")
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		t.Fatal(err)
	}
	ids := jobProcessIDs(job)
	if len(ids) != 1 || ids[0] != uint32(cmd.Process.Pid) {
		t.Fatalf("got %v, want [%d]", ids, cmd.Process.Pid)
	}
}
