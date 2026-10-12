package main

type processMetrics struct {
	CPUPercent float64
	// ActiveCPUPercent is the instantaneous tree sum. CPUPercent is replaced by
	// the lifetime average on Linux, which stays high long after startup work.
	ActiveCPUPercent    float64
	CPUTicks            uint64
	StartTime           uint64
	MemoryBytes         uint64
	ResidentMemoryBytes uint64
	ProcessCount        int
}

type procRecord struct {
	PID        int
	ParentPID  int
	RSSBytes   uint64
	Footprint  uint64
	CPUPercent float64
	CPUTicks   uint64
	StartTime  uint64
	Command    string
}

func sampleMetrics(rootPIDs map[int]struct{}) map[int]processMetrics {
	records := listProcesses()
	parent := map[int]int{}
	for _, rec := range records {
		parent[rec.PID] = rec.ParentPID
	}
	owner := func(pid int) int {
		seen := map[int]bool{}
		current := pid
		for current > 0 && !seen[current] {
			seen[current] = true
			if _, ok := rootPIDs[current]; ok {
				return current
			}
			next, ok := parent[current]
			if !ok {
				return 0
			}
			current = next
		}
		return 0
	}
	totals := map[int]processMetrics{}
	for _, rec := range records {
		root := owner(rec.PID)
		if root == 0 {
			continue
		}
		m := totals[root]
		m.CPUPercent += rec.CPUPercent
		m.ActiveCPUPercent += rec.CPUPercent
		m.CPUTicks += rec.CPUTicks
		m.MemoryBytes += rec.Footprint
		m.ResidentMemoryBytes += rec.RSSBytes
		m.ProcessCount++
		if rec.PID == root {
			m.StartTime = rec.StartTime
		}
		totals[root] = m
	}
	for root, m := range totals {
		if avg, ok := lifetimeCPUPercent(m); ok {
			m.CPUPercent = avg
		}
		totals[root] = m
	}
	return totals
}

