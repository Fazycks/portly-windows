//go:build !windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

func processExecutable(pid int) string {
	path, _ := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	return path
}

func processWorkingDirectory(pid int) string {
	path, _ := os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid))
	return path
}

func processCommandLine(pid int) string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.ReplaceAll(string(data), "\x00", " "))
}

// systemMemory reads /proc/meminfo; other Unix hosts report zero.
func systemMemory() (total, available uint64) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		kb, _ := strconv.ParseUint(fields[1], 10, 64)
		switch fields[0] {
		case "MemTotal:":
			total = kb * 1024
		case "MemAvailable:":
			available = kb * 1024
		}
	}
	return total, available
}

func sameUserProcess(pid int) bool {
	if runtime.GOOS != "linux" {
		return true
	}
	info, err := os.Stat(fmt.Sprintf("/proc/%d", pid))
	if err != nil {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}

// startTimeToken turns a procRecord start time into a JSON-safe identity.
func startTimeToken(start uint64) int64 { return int64(start) }
