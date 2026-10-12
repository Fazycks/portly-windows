//go:build windows

package main

import (
	"encoding/binary"
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modIphlpapi             = windows.NewLazySystemDLL("iphlpapi.dll")
	procGetExtendedTcpTable = modIphlpapi.NewProc("GetExtendedTcpTable")
)

const tcpTableOwnerPIDListener = 3

func platformOccupant(port int) *listener {
	for _, l := range allListeners() {
		if l.Port == port {
			occ := l
			return &occ
		}
	}
	return nil
}

// allListeners reads the IPv4 and IPv6 TCP listener tables with owning pids.
func allListeners() []listener {
	names := processNames()
	user := currentUser()
	seen := map[string]bool{}
	var result []listener
	add := func(addr string, port int, pid uint32) {
		if pid == 0 || pid == 4 { // System Idle / kernel (http.sys)
			return
		}
		key := fmt.Sprintf("%d/%d", pid, port)
		if seen[key] {
			return
		}
		seen[key] = true
		result = append(result, listener{
			Port:    port,
			PID:     int(pid),
			Command: strings.TrimSuffix(strings.TrimSuffix(names[pid], ".exe"), ".EXE"),
			User:    user,
			Address: addr,
		})
	}
	if buf := extendedTCPTable(windows.AF_INET); len(buf) >= 4 {
		n := int(binary.LittleEndian.Uint32(buf))
		const rowSize = 24 // state, localAddr, localPort, remoteAddr, remotePort, pid
		for i := 0; i < n && 4+(i+1)*rowSize <= len(buf); i++ {
			row := buf[4+i*rowSize:]
			ip := net.IP(row[4:8]).String()
			port := int(binary.BigEndian.Uint16(row[8:10]))
			add(ip, port, binary.LittleEndian.Uint32(row[20:24]))
		}
	}
	if buf := extendedTCPTable(windows.AF_INET6); len(buf) >= 4 {
		n := int(binary.LittleEndian.Uint32(buf))
		const rowSize = 56 // localAddr[16], scope, port, remoteAddr[16], scope, port, state, pid
		for i := 0; i < n && 4+(i+1)*rowSize <= len(buf); i++ {
			row := buf[4+i*rowSize:]
			ip := net.IP(row[0:16]).String()
			port := int(binary.BigEndian.Uint16(row[20:22]))
			add(ip, port, binary.LittleEndian.Uint32(row[52:56]))
		}
	}
	return result
}

func extendedTCPTable(family uint32) []byte {
	size := uint32(16 * 1024)
	for attempt := 0; attempt < 4; attempt++ {
		buf := make([]byte, size)
		r, _, _ := procGetExtendedTcpTable.Call(
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(unsafe.Pointer(&size)),
			0,
			uintptr(family),
			tcpTableOwnerPIDListener,
			0,
		)
		switch r {
		case 0:
			return buf[:size]
		case uintptr(windows.ERROR_INSUFFICIENT_BUFFER):
			size += 4096
			continue
		default:
			return nil
		}
	}
	return nil
}

func commandForPID(pid int) string {
	if name := processNames()[uint32(pid)]; name != "" {
		return strings.TrimSuffix(name, ".exe")
	}
	return "unknown"
}

// terminatePID stops a process tree: a polite taskkill first (window close),
// then a forced one for console programs or anything still alive after 2s.
func terminatePID(pid int) error {
	if !processAlive(pid) {
		return fmt.Errorf("process %d is not running", pid)
	}
	polite := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T")
	hideWindow(polite)
	if polite.Run() == nil {
		go func() {
			time.Sleep(2 * time.Second)
			if processAlive(pid) {
				killProcessTree(pid)
			}
		}()
		return nil
	}
	force := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	hideWindow(force)
	if out, err := force.CombinedOutput(); err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(string(out)))
	}
	return nil
}

func processAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	ev, err := windows.WaitForSingleObject(h, 0)
	return err == nil && ev == uint32(windows.WAIT_TIMEOUT)
}
