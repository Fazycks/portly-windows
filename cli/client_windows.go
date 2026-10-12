//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

// daemonExecutable prefers portlyd.exe next to portly.exe: it is built for the
// GUI subsystem, so the background daemon never owns a console window.
func daemonExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if sibling := filepath.Join(filepath.Dir(exe), "portlyd.exe"); fileExists(sibling) {
		return sibling, nil
	}
	return exe, nil
}

// No CREATE_NEW_PROCESS_GROUP: it makes the daemon and every server it starts
// ignore Ctrl+C, the polite stop signal.
const detachedFlags = windows.DETACHED_PROCESS | windows.CREATE_NO_WINDOW

// detachDaemon starts the daemon outside the CLI's console and, when allowed,
// outside any job object the caller belongs to (terminals, IDEs, CI runners).
func detachDaemon(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: detachedFlags | windows.CREATE_BREAKAWAY_FROM_JOB,
	}
}

func startDetached(cmd *exec.Cmd) error {
	err := cmd.Start()
	if err == nil {
		return nil
	}
	// Breakaway is refused when the parent job forbids it; start inside it.
	// An exec.Cmd cannot be started twice, so build a fresh one.
	retry := exec.Command(cmd.Path, cmd.Args[1:]...)
	retry.Dir, retry.Env = cmd.Dir, cmd.Env
	retry.Stdin, retry.Stdout, retry.Stderr = cmd.Stdin, cmd.Stdout, cmd.Stderr
	retry.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: detachedFlags}
	if err := retry.Start(); err != nil {
		return err
	}
	cmd.Process = retry.Process
	return nil
}
