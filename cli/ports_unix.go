//go:build !windows

package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

func platformOccupant(port int) *listener {
	if occ := occupantFromProc(port); occ != nil {
		return occ
	}
	if occ := occupantFromSS(port); occ != nil {
		return occ
	}
	return occupantFromLsof(port)
}

// terminatePID asks a process to exit (SIGTERM).
func terminatePID(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }

// allListeners lists every TCP listening socket visible to the user.
func allListeners() []listener {
	out, err := exec.Command("lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-FpcLn").Output()
	if err != nil {
		return nil
	}
	var result []listener
	seen := map[string]bool{}
	var pid int
	command, user := "unknown", currentUser()
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(line[1:])
			command, user = "unknown", currentUser()
		case 'c':
			command = line[1:]
		case 'L':
			user = line[1:]
		case 'n':
			addr := line[1:]
			i := strings.LastIndex(addr, ":")
			if i < 0 {
				continue
			}
			port, err := strconv.Atoi(addr[i+1:])
			if err != nil || pid == 0 {
				continue
			}
			key := fmt.Sprintf("%d/%d", pid, port)
			if seen[key] {
				continue
			}
			seen[key] = true
			result = append(result, listener{Port: port, PID: pid, Command: command, User: user, Address: addr[:i]})
		}
	}
	return result
}

func occupantFromProc(port int) *listener {
	if runtime.GOOS != "linux" {
		return nil
	}
	for _, table := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		if occ := scanProcNet(table, port); occ != nil {
			return occ
		}
	}
	return nil
}

func scanProcNet(path string, port int) *listener {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	if !scanner.Scan() {
		return nil
	}
	want := strings.ToUpper(fmt.Sprintf("%04X", port))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 {
			continue
		}
		local := fields[1]
		state := fields[3]
		inode := fields[9]
		if state != "0A" {
			continue
		}
		parts := strings.Split(local, ":")
		if len(parts) != 2 || !strings.EqualFold(parts[1], want) {
			continue
		}
		pid, cmd := pidForInode(inode)
		if pid == 0 {
			continue
		}
		return &listener{Port: port, PID: pid, Command: cmd, User: currentUser()}
	}
	return nil
}

func pidForInode(inode string) (int, string) {
	matches, _ := filepath.Glob("/proc/[0-9]*/fd/*")
	needle := "socket:[" + inode + "]"
	for _, fd := range matches {
		target, err := os.Readlink(fd)
		if err != nil || target != needle {
			continue
		}
		pid, _ := strconv.Atoi(strings.Split(fd, "/")[2])
		return pid, commandForPID(pid)
	}
	return 0, ""
}

func commandForPID(pid int) string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(data))
}

func occupantFromSS(port int) *listener {
	out, err := exec.Command("ss", "-lptn", fmt.Sprintf("sport = :%d", port)).Output()
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "pid=") {
			continue
		}
		pid := extractAfter(line, "pid=")
		cmd := extractBetween(line, "users:((\"", "\"")
		if pid == 0 {
			continue
		}
		if cmd == "" {
			cmd = commandForPID(pid)
		}
		return &listener{Port: port, PID: pid, Command: cmd, User: currentUser()}
	}
	return nil
}

func occupantFromLsof(port int) *listener {
	out, err := exec.Command("lsof", "-nP", fmt.Sprintf("-iTCP:%d", port), "-sTCP:LISTEN", "-FpcLn").Output()
	if err != nil {
		return nil
	}
	var pid int
	command, user := "unknown", currentUser()
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			if pid != 0 {
				return &listener{Port: port, PID: pid, Command: command, User: user}
			}
			pid, _ = strconv.Atoi(line[1:])
		case 'c':
			command = line[1:]
		case 'L':
			user = line[1:]
		}
	}
	if pid == 0 {
		return nil
	}
	return &listener{Port: port, PID: pid, Command: command, User: user}
}

