//go:build !windows

package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const linuxClockTicks = 100

type cpuSnapshot struct {
	ticks uint64
	at    time.Time
}

var (
	cpuMu       sync.Mutex
	cpuPrevious = map[int]cpuSnapshot{}
)

// lifetimeCPUPercent averages the tree's CPU time over the root's lifetime.
func lifetimeCPUPercent(m processMetrics) (float64, bool) {
	life := processLifetime(m.StartTime, linuxUptime())
	if life <= 0 || m.CPUTicks == 0 {
		return 0, false
	}
	return float64(m.CPUTicks) / linuxClockTicks / life * 100, true
}

func listProcesses() []procRecord {
	if runtime.GOOS == "linux" {
		if recs := listLinuxProcesses(); len(recs) > 0 {
			return recs
		}
	}
	return listPSProcesses()
}

func listLinuxProcesses() []procRecord {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var recs []procRecord
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil {
			continue
		}
		ppid, rssPages, ticks, startTime := parseStat(string(stat))
		rss := uint64(rssPages) * uint64(os.Getpagesize())
		footprint := linuxFootprint(pid, rss)
		recs = append(recs, procRecord{
			PID:        pid,
			ParentPID:  ppid,
			RSSBytes:   rss,
			Footprint:  footprint,
			CPUPercent: linuxCPUPercent(pid, ticks),
			CPUTicks:   ticks,
			StartTime:  startTime,
			Command:    commandForPID(pid),
		})
	}
	pruneCPUSnapshots(recs)
	return recs
}

func parseStat(stat string) (ppid int, rssPages int, cpuTicks uint64, startTime uint64) {
	rparen := strings.LastIndex(stat, ")")
	if rparen < 0 || rparen+2 >= len(stat) {
		return 0, 0, 0, 0
	}
	fields := strings.Fields(stat[rparen+2:])
	if len(fields) < 22 {
		return 0, 0, 0, 0
	}
	ppid, _ = strconv.Atoi(fields[1])
	utime, _ := strconv.ParseUint(fields[11], 10, 64)
	stime, _ := strconv.ParseUint(fields[12], 10, 64)
	startTime, _ = strconv.ParseUint(fields[19], 10, 64)
	rssPages, _ = strconv.Atoi(fields[21])
	return ppid, rssPages, utime + stime, startTime
}

func linuxUptime() float64 {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0
	}
	uptime, _ := strconv.ParseFloat(fields[0], 64)
	return uptime
}

func processLifetime(startTime uint64, uptime float64) float64 {
	life := uptime - float64(startTime)/linuxClockTicks
	if life < 0 {
		return 0
	}
	return life
}

func linuxCPUPercent(pid int, ticks uint64) float64 {
	now := time.Now()
	cpuMu.Lock()
	defer cpuMu.Unlock()
	previous, ok := cpuPrevious[pid]
	cpuPrevious[pid] = cpuSnapshot{ticks: ticks, at: now}
	if !ok || ticks < previous.ticks {
		return 0
	}
	elapsed := now.Sub(previous.at).Seconds()
	if elapsed < 0.2 {
		return 0
	}
	return float64(ticks-previous.ticks) / linuxClockTicks / elapsed * 100
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

func linuxFootprint(pid int, rss uint64) uint64 {
	f, err := os.Open(fmt.Sprintf("/proc/%d/smaps_rollup", pid))
	if err != nil {
		return rss
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "Pss:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ := strconv.ParseUint(fields[1], 10, 64)
				return kb * 1024
			}
		}
	}
	return rss
}

func listPSProcesses() []procRecord {
	cmd := exec.Command("ps", "-axo", "pid=,ppid=,rss=,%cpu=,command=")
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var recs []procRecord
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		ppid, err2 := strconv.Atoi(fields[1])
		rssKB, err3 := strconv.ParseUint(fields[2], 10, 64)
		cpu, err4 := strconv.ParseFloat(fields[3], 64)
		if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
			continue
		}
		recs = append(recs, procRecord{
			PID:        pid,
			ParentPID:  ppid,
			RSSBytes:   rssKB * 1024,
			Footprint:  rssKB * 1024,
			CPUPercent: cpu,
			Command:    strings.Join(fields[4:], " "),
		})
	}
	return recs
}
