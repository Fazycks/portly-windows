//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func daemonExecutable() (string, error) { return os.Executable() }

// detachDaemon puts the daemon in its own session so it outlives the CLI.
func detachDaemon(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

func startDetached(cmd *exec.Cmd) error { return cmd.Start() }
