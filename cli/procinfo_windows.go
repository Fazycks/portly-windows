//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// Reading another process's current directory needs its PEB; the dashboard
// treats an empty value as unknown.
func processWorkingDirectory(int) string { return "" }

// sameUserProcess reports whether the process runs as the daemon's own user
// (same token user SID). Session-mates such as dwm.exe or csrss.exe run as
// other accounts and are never offered as stoppable.
func sameUserProcess(pid int) bool {
	if pid <= 4 {
		return false
	}
	mine := processUserSID(uint32(os.Getpid()))
	theirs := processUserSID(uint32(pid))
	return mine != "" && mine == theirs
}

func processUserSID(pid uint32) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	var token windows.Token
	if windows.OpenProcessToken(h, windows.TOKEN_QUERY, &token) != nil {
		return ""
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return ""
	}
	return user.User.Sid.String()
}

// startTimeToken converts a FILETIME (100ns since 1601) to Unix milliseconds,
// which survives a round trip through JavaScript numbers.
func startTimeToken(start uint64) int64 {
	const epochDelta = 116444736000000000
	if start < epochDelta {
		return int64(start)
	}
	return int64((start - epochDelta) / 10_000)
}
