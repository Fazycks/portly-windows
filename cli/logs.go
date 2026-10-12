package main

import (
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type logStore struct {
	mu           sync.Mutex
	serverID     string
	maxLines     int
	maxBytes     int
	lines        []string
	partial      []byte
	bytesWritten int
	file         *os.File

	// raw keeps the unsanitized terminal stream for the UI's terminal view.
	// rawBase is the absolute stream offset of raw[0]; waiters are woken on
	// every append so /output can long-poll.
	raw     []byte
	rawBase uint64
	waiters chan struct{}
}

const rawOutputLimit = 2 << 20

func newLogStore(serverID string, maxLines, maxMB int) *logStore {
	s := &logStore{
		serverID: serverID,
		maxLines: max(100, maxLines),
		maxBytes: max(1, maxMB) * 1_000_000,
	}
	s.openFile()
	return s
}

func (s *logStore) appendBytes(chunk []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendRaw(chunk)
	s.ingest(string(chunk))
}

func (s *logStore) note(message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendRaw([]byte("\r\n\x1b[2m[portly] " + message + "\x1b[0m\r\n"))
	s.ingest("[portly] " + message + "\n")
}

func (s *logStore) appendRaw(chunk []byte) {
	s.raw = append(s.raw, chunk...)
	if over := len(s.raw) - rawOutputLimit; over > 0 {
		s.raw = append([]byte{}, s.raw[over:]...)
		s.rawBase += uint64(over)
	}
	if s.waiters != nil {
		close(s.waiters)
		s.waiters = nil
	}
}

// rawSinceLocked returns terminal output after offset. reset is true when the
// caller's offset fell out of the buffer (or the buffer was cleared) and the
// returned data starts over from the oldest byte still kept.
func (s *logStore) rawSinceLocked(offset uint64) (uint64, []byte, bool) {
	end := s.rawBase + uint64(len(s.raw))
	reset := false
	if offset < s.rawBase || offset > end {
		offset, reset = s.rawBase, true
	}
	chunk := s.raw[offset-s.rawBase:]
	if reset {
		// Never start a replay inside a UTF-8 sequence.
		skip := 0
		for skip < len(chunk) && skip < 3 && chunk[skip]&0xC0 == 0x80 {
			skip++
		}
		chunk = chunk[skip:]
		offset += uint64(skip)
	}
	chunk = chunk[:completeUTF8Prefix(chunk)]
	out := make([]byte, len(chunk))
	copy(out, chunk)
	return offset + uint64(len(out)), out, reset
}

// waitRaw blocks until output newer than offset exists, the timeout passes,
// or cancel closes.
func (s *logStore) waitRaw(offset uint64, timeout time.Duration, cancel <-chan struct{}) (uint64, []byte, bool) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		s.mu.Lock()
		next, data, reset := s.rawSinceLocked(offset)
		if len(data) > 0 || reset {
			s.mu.Unlock()
			return next, data, reset
		}
		if s.waiters == nil {
			s.waiters = make(chan struct{})
		}
		wake := s.waiters
		s.mu.Unlock()
		select {
		case <-wake:
		case <-deadline.C:
			return next, nil, false
		case <-cancel:
			return next, nil, false
		}
	}
}

// clearRaw drops the scrollback. Offsets keep counting so pollers continue
// from the current end without a reset.
func (s *logStore) clearRaw() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rawBase += uint64(len(s.raw))
	s.raw = nil
	s.lines = nil
}

// completeUTF8Prefix returns the length of b without a trailing incomplete
// UTF-8 sequence, so a chunk never splits a character.
func completeUTF8Prefix(b []byte) int {
	n := len(b)
	for i := 1; i <= 4 && i <= n; i++ {
		c := b[n-i]
		if c&0xC0 == 0x80 {
			continue
		}
		size := 1
		switch {
		case c&0xE0 == 0xC0:
			size = 2
		case c&0xF0 == 0xE0:
			size = 3
		case c&0xF8 == 0xF0:
			size = 4
		}
		if size > i {
			return n - i
		}
		return n
	}
	return n
}

func (s *logStore) ingest(chunk string) {
	s.partial = append(s.partial, chunk...)
	for {
		idx, width := nextLineBreak(s.partial)
		if idx < 0 {
			break
		}
		line := s.partial[:idx]
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		clean := sanitizeLog(string(line))
		// A cursor jump on an empty line (ConPTY's clear-and-home) is not a line.
		if width == 1 || strings.TrimSpace(clean) != "" {
			s.emit(clean)
		}
		s.partial = s.partial[idx+width:]
	}
	if len(s.partial) > 8000 {
		s.emit(sanitizeLog(string(s.partial)))
		s.partial = nil
	}
}

func (s *logStore) emit(line string) {
	s.lines = append(s.lines, line)
	if len(s.lines) > s.maxLines {
		s.lines = append([]string{}, s.lines[len(s.lines)-s.maxLines:]...)
	}
	s.writeToFile(line)
}

func (s *logStore) tail(count int) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if count < 1 {
		count = 1
	}
	if count > len(s.lines) {
		count = len(s.lines)
	}
	out := make([]string, count)
	copy(out, s.lines[len(s.lines)-count:])
	return out
}

func (s *logStore) updateLimits(maxLines, maxMB int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maxLines = max(100, maxLines)
	s.maxBytes = max(1, maxMB) * 1_000_000
	if len(s.lines) > s.maxLines {
		s.lines = append([]string{}, s.lines[len(s.lines)-s.maxLines:]...)
	}
}

func (s *logStore) openFile() {
	_ = ensureDirs()
	path := logFile(s.serverID)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	info, _ := f.Stat()
	if info != nil {
		s.bytesWritten = int(info.Size())
	}
	s.file = f
}

// close releases the log file (Windows refuses to delete open files).
func (s *logStore) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file != nil {
		_ = s.file.Close()
		s.file = nil
	}
}

func (s *logStore) writeToFile(line string) {
	if s.file == nil {
		return
	}
	stamped := time.Now().Format("15:04:05") + " " + line + "\n"
	n, err := s.file.WriteString(stamped)
	if err == nil {
		s.bytesWritten += n
	}
	if s.bytesWritten > s.maxBytes {
		s.rotate()
	}
}

func (s *logStore) rotate() {
	if s.file != nil {
		_ = s.file.Close()
		s.file = nil
	}
	path := logFile(s.serverID)
	previous := strings.TrimSuffix(path, ".log") + ".1.log"
	_ = os.Remove(previous)
	_ = os.Rename(path, previous)
	s.bytesWritten = 0
	s.openFile()
}

func indexByte(b []byte, c byte) int {
	for i, v := range b {
		if v == c {
			return i
		}
	}
	return -1
}

// nextLineBreak finds the next "\n", or a cursor move to column 1 of a row
// (CSI row;1H, CSI rowH, CSI nE). ConPTY repaints with those instead of
// newlines, so without them consecutive output lines would run together.
// It returns the index and length of the break, or -1.
func nextLineBreak(b []byte) (int, int) {
	for i := 0; i < len(b); i++ {
		if b[i] == '\n' {
			return i, 1
		}
		if b[i] != 0x1b || i+1 >= len(b) || b[i+1] != '[' {
			continue
		}
		j := i + 2
		for j < len(b) && (b[j] >= '0' && b[j] <= '9' || b[j] == ';') {
			j++
		}
		if j >= len(b) {
			return -1, 0 // incomplete sequence: wait for the rest
		}
		params := string(b[i+2 : j])
		switch b[j] {
		case 'E':
			return i, j + 1 - i
		case 'H', 'f':
			if _, col, _ := strings.Cut(params, ";"); col == "" || col == "1" {
				return i, j + 1 - i
			}
		}
	}
	return -1, 0
}

func sanitizeLog(input string) string {
	var out []rune
	runes := []rune(input)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if r == 0x1b {
			i++
			if i >= len(runes) {
				break
			}
			next := runes[i]
			switch next {
			case '[':
				i++
				paramStart := i
				for i < len(runes) && (runes[i] < 0x40 || runes[i] > 0x7e) {
					i++
				}
				// ConPTY writes runs of spaces as "cursor forward n".
				if i < len(runes) && runes[i] == 'C' {
					n, err := strconv.Atoi(string(runes[paramStart:i]))
					if err != nil || n < 1 {
						n = 1
					}
					for k := 0; k < min(n, 200); k++ {
						out = append(out, ' ')
					}
				}
			case ']':
				i++
				for i < len(runes) {
					if runes[i] == 0x07 {
						break
					}
					if runes[i] == 0x1b && i+1 < len(runes) && runes[i+1] == '\\' {
						i++
						break
					}
					i++
				}
			}
			continue
		}
		if r == '\r' {
			out = out[:0]
			continue
		}
		if r == 0x07 || r == 0x08 {
			continue
		}
		out = append(out, r)
	}
	return string(out)
}
