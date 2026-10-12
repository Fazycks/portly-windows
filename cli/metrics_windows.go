//go:build windows

package main

import (
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modPsapi                 = windows.NewLazySystemDLL("psapi.dll")
	procGetProcessMemoryInfo = modPsapi.NewProc("GetProcessMemoryInfo")
)

// processMemoryCountersEx mirrors PROCESS_MEMORY_COUNTERS_EX.
type processMemoryCountersEx struct {
	cb                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
	PrivateUsage               uintptr
}

type cpuSnapshot struct {
	cpu100ns uint64
	at       time.Time
}

var (
	cpuMu       sync.Mutex
	cpuPrevious = map[int]cpuSnapshot{}
)

// lifetimeCPUPercent averages the tree's CPU time over the root's lifetime.
// CPUTicks and StartTime are both in 100ns units (FILETIME).
func lifetimeCPUPercent(m processMetrics) (float64, bool) {
	if m.StartTime == 0 || m.CPUTicks == 0 {
		return 0, false
	}
	now := uint64(time.Now().UnixNano()/100) + 116444736000000000
	if now <= m.StartTime {
		return 0, false
	}
	return float64(m.CPUTicks) / float64(now-m.StartTime) * 100, true
}

func listProcesses() []procRecord {
	snapshot := processSnapshot()
	recs := make([]procRecord, 0, len(snapshot))
	for _, p := range snapshot {
		rec := procRecord{PID: int(p.pid), ParentPID: int(p.ppid), Command: strings.TrimSuffix(p.exe, ".exe")}
		if info, ok := queryProcess(p.pid); ok {
			rec.RSSBytes = info.resident
			rec.Footprint = info.private
			rec.CPUTicks = info.cpu100ns
			rec.StartTime = info.created
			rec.CPUPercent = windowsCPUPercent(rec.PID, info.cpu100ns)
		}
		recs = append(recs, rec)
	}
	pruneCPUSnapshots(recs)
	return recs
}

type processInfo struct {
	resident, private uint64
	cpu100ns, created uint64
}

func queryProcess(pid uint32) (processInfo, bool) {
	if pid == 0 {
		return processInfo{}, false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return processInfo{}, false
	}
	defer windows.CloseHandle(h)
	var info processInfo
	var mem processMemoryCountersEx
	mem.cb = uint32(unsafe.Sizeof(mem))
	if r, _, _ := procGetProcessMemoryInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&mem)), uintptr(mem.cb)); r != 0 {
		info.resident = uint64(mem.WorkingSetSize)
		info.private = uint64(mem.PrivateUsage)
	}
	var created, exited, kernel, user windows.Filetime
	if windows.GetProcessTimes(h, &created, &exited, &kernel, &user) == nil {
		info.cpu100ns = filetime64(kernel) + filetime64(user)
		info.created = filetime64(created)
	}
	return info, true
}

func filetime64(ft windows.Filetime) uint64 {
	return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime)
}

// windowsCPUPercent reports CPU use since the previous sample, where 100%
// is one fully busy core (same convention as `ps` and Activity Monitor).
func windowsCPUPercent(pid int, cpu100ns uint64) float64 {
	now := time.Now()
	cpuMu.Lock()
	defer cpuMu.Unlock()
	previous, ok := cpuPrevious[pid]
	cpuPrevious[pid] = cpuSnapshot{cpu100ns: cpu100ns, at: now}
	if !ok || cpu100ns < previous.cpu100ns {
		return 0
	}
	elapsed := now.Sub(previous.at).Seconds()
	if elapsed < 0.2 {
		return 0
	}
	return float64(cpu100ns-previous.cpu100ns) / 1e7 / elapsed * 100
}

func pruneCPUSnapshots(recs []procRecord) {
	cpuMu.Lock()
	defer cpuMu.Unlock()
	live := map[int]bool{}
	for _, rec := range recs {
		live[rec.PID] = true
	}
	for pid := range cpuPrevious {
		if !live[pid] {
			delete(cpuPrevious, pid)
		}
	}
}

// processCommandLine reads the full command line (NtQueryInformationProcess,
// ProcessCommandLineInformation). Empty when access is denied.
func processCommandLine(pid int) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	buf := make([]byte, 4096)
	for attempt := 0; attempt < 3; attempt++ {
		var needed uint32
		err := windows.NtQueryInformationProcess(h, windows.ProcessCommandLineInformation,
			unsafe.Pointer(&buf[0]), uint32(len(buf)), &needed)
		if err == nil {
			us := (*windows.NTUnicodeString)(unsafe.Pointer(&buf[0]))
			if us.Length == 0 || us.Buffer == nil {
				return ""
			}
			return utf16Slice(us.Buffer, int(us.Length/2))
		}
		if needed > uint32(len(buf)) && needed < 1<<20 {
			buf = make([]byte, needed)
			continue
		}
		return ""
	}
	return ""
}

func utf16Slice(p *uint16, n int) string {
	return windows.UTF16ToString(unsafe.Slice(p, n))
}

// processExecutable returns the full image path of a process.
func processExecutable(pid int) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &size); err != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:size])
}

// systemMemory returns total and available physical memory.
func systemMemory() (total, available uint64) {
	var status memoryStatusEx
	status.Length = uint32(unsafe.Sizeof(status))
	if r, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status))); r == 0 {
		return 0, 0
	}
	return status.TotalPhys, status.AvailPhys
}

var procGlobalMemoryStatusEx = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}
