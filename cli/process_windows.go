//go:build windows

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Exit status Windows reports for a console process ended by Ctrl+C.
const statusControlCExit = 0xC000013A

// childProcess is a server command hosted in a pseudo console (ConPTY) and
// confined to a Job Object, so the whole tree can be stopped like a Unix
// process group.
type childProcess struct {
	process windows.Handle
	thread  windows.Handle
	job     windows.Handle
	hpc     windows.Handle
	pidNum  int

	input  *os.File // keyboard side of the pseudo console
	output *os.File // rendered terminal output
	reader *eofReader

	mu       sync.Mutex
	closed   bool
	stopping bool
}

type exitStatusError struct{ code uint32 }

func (e *exitStatusError) Error() string { return fmt.Sprintf("exit status %d", e.code) }

// eofReader signals when the output pipe has been fully drained so wait() can
// return only after the last bytes reached the log.
type eofReader struct {
	r    io.Reader
	once sync.Once
	done chan struct{}
}

func (e *eofReader) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err != nil {
		e.once.Do(func() { close(e.done) })
	}
	return n, err
}

// windowsShell returns the command interpreter used to run server commands.
// PORTLY_SHELL may point at another shell (e.g. pwsh); it then receives
// `-Command <command>`.
func windowsShell(command string) string {
	if custom := strings.TrimSpace(os.Getenv("PORTLY_SHELL")); custom != "" {
		return windows.EscapeArg(custom) + " -NoLogo -Command " + windows.EscapeArg(command)
	}
	comspec := os.Getenv("ComSpec")
	if comspec == "" {
		comspec = `C:\Windows\System32\cmd.exe`
	}
	return windows.EscapeArg(comspec) + ` /d /s /c "` + command + `"`
}

func startChild(command, dir string, env []string) (*childProcess, io.Reader, error) {
	child, err := startConPTY(command, dir, env)
	if err != nil {
		return nil, nil, err
	}
	return child, child.reader, nil
}

func startConPTY(command, dir string, env []string) (child *childProcess, err error) {
	var inRead, inWrite, outRead, outWrite windows.Handle
	if err := windows.CreatePipe(&inRead, &inWrite, nil, 0); err != nil {
		return nil, fmt.Errorf("create input pipe: %w", err)
	}
	if err := windows.CreatePipe(&outRead, &outWrite, nil, 0); err != nil {
		windows.CloseHandle(inRead)
		windows.CloseHandle(inWrite)
		return nil, fmt.Errorf("create output pipe: %w", err)
	}
	// The pseudo console owns its ends after creation; ours are closed below.
	defer windows.CloseHandle(inRead)
	defer windows.CloseHandle(outWrite)

	c := &childProcess{
		input:  os.NewFile(uintptr(inWrite), "conpty-in"),
		output: os.NewFile(uintptr(outRead), "conpty-out"),
	}
	defer func() {
		if err != nil {
			c.release()
		}
	}()

	if err := windows.CreatePseudoConsole(windows.Coord{X: 120, Y: 30}, inRead, outWrite, 0, &c.hpc); err != nil {
		return nil, fmt.Errorf("create pseudo console: %w", err)
	}

	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, err
	}
	defer attrs.Delete()
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&c.hpc)), unsafe.Sizeof(c.hpc)); err != nil {
		return nil, fmt.Errorf("attach pseudo console: %w", err)
	}

	job, err := newKillOnCloseJob()
	if err != nil {
		return nil, err
	}
	c.job = job

	si := &windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	si.Cb = uint32(unsafe.Sizeof(*si))
	si.Flags = windows.STARTF_USESTDHANDLES // no inherited std handles: the console provides them

	cmdLine, err := windows.UTF16PtrFromString(windowsShell(command))
	if err != nil {
		return nil, err
	}
	var dirPtr *uint16
	if dir != "" {
		if dirPtr, err = windows.UTF16PtrFromString(dir); err != nil {
			return nil, err
		}
	}
	envBlock := environmentBlock(env)

	var pi windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_SUSPENDED | windows.CREATE_UNICODE_ENVIRONMENT)
	if err := windows.CreateProcess(nil, cmdLine, nil, nil, false, flags, &envBlock[0], dirPtr, &si.StartupInfo, &pi); err != nil {
		return nil, fmt.Errorf("start %q: %w", command, err)
	}
	c.process, c.thread, c.pidNum = pi.Process, pi.Thread, int(pi.ProcessId)
	if err := windows.AssignProcessToJobObject(c.job, c.process); err != nil {
		_ = windows.TerminateProcess(c.process, 1)
		return nil, fmt.Errorf("assign job: %w", err)
	}
	if _, err := windows.ResumeThread(c.thread); err != nil {
		_ = windows.TerminateProcess(c.process, 1)
		return nil, fmt.Errorf("resume: %w", err)
	}
	c.reader = &eofReader{r: c.output, done: make(chan struct{})}
	return c, nil
}

func newKillOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("create job object: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0, fmt.Errorf("configure job object: %w", err)
	}
	return job, nil
}

// environmentBlock builds a CREATE_UNICODE_ENVIRONMENT block: NUL-separated
// KEY=VALUE pairs sorted case-insensitively, terminated by an extra NUL.
func environmentBlock(env []string) []uint16 {
	seen := map[string]int{}
	var list []string
	for _, kv := range env {
		if kv == "" {
			continue
		}
		key := kv
		if i := strings.Index(kv[1:], "="); i >= 0 {
			key = kv[:i+1]
		}
		k := strings.ToUpper(key)
		if idx, ok := seen[k]; ok {
			list[idx] = kv
			continue
		}
		seen[k] = len(list)
		list = append(list, kv)
	}
	sort.SliceStable(list, func(i, j int) bool { return strings.ToUpper(list[i]) < strings.ToUpper(list[j]) })
	var block []uint16
	for _, kv := range list {
		if strings.ContainsRune(kv, 0) {
			continue
		}
		u, _ := windows.UTF16FromString(kv)
		block = append(block, u...)
	}
	if len(block) == 0 {
		block = append(block, 0)
	}
	return append(block, 0)
}

// jobProcessIDs lists the processes still alive inside the job.
func jobProcessIDs(job windows.Handle) []uint32 {
	// JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counters, then ULONG_PTR ids.
	type processIDList struct {
		assigned, listed uint32
		ids              [512]uintptr
	}
	var list processIDList
	if err := windows.QueryInformationJobObject(job, windows.JobObjectBasicProcessIdList,
		uintptr(unsafe.Pointer(&list)), uint32(unsafe.Sizeof(list)), nil); err != nil {
		return nil
	}
	n := min(int(list.listed), len(list.ids))
	ids := make([]uint32, 0, n)
	for _, id := range list.ids[:n] {
		ids = append(ids, uint32(id))
	}
	return ids
}

// Shell helpers that linger after the real server answered Ctrl+C
// (e.g. cmd's "Terminate batch job (Y/N)?" prompt for npm.cmd).
var lingeringShells = map[string]bool{"cmd.exe": true, "conhost.exe": true, "openconsole.exe": true}

// terminate sends Ctrl+C through the pseudo console, like pressing it in a
// terminal. Once only shell wrappers remain, the job is ended.
func (c *childProcess) terminate() {
	if c == nil {
		return
	}
	c.mu.Lock()
	if c.closed || c.stopping {
		c.mu.Unlock()
		return
	}
	c.stopping = true
	c.mu.Unlock()
	_, _ = c.input.Write([]byte{0x03})
	go func() {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			time.Sleep(200 * time.Millisecond)
			c.mu.Lock()
			if c.closed {
				c.mu.Unlock()
				return
			}
			ids := jobProcessIDs(c.job)
			names := processNames()
			onlyShells := len(ids) > 0
			for _, id := range ids {
				if !lingeringShells[strings.ToLower(names[id])] {
					onlyShells = false
					break
				}
			}
			if onlyShells {
				_ = windows.TerminateJobObject(c.job, statusControlCExit)
				c.mu.Unlock()
				return
			}
			c.mu.Unlock()
		}
	}()
}

// forceKill ends every process in the job.
func (c *childProcess) forceKill() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed && c.job != 0 {
		_ = windows.TerminateJobObject(c.job, 137)
	}
}

func (c *childProcess) stopNote() string {
	return fmt.Sprintf("stopping (Ctrl+C to process tree %d)", c.pidNum)
}

func (c *childProcess) killNote() string { return "did not exit in 5s, terminating the job object" }

// write sends keyboard input to the pseudo console.
func (c *childProcess) write(data []byte) error {
	if c == nil || c.input == nil {
		return fmt.Errorf("this process has no terminal")
	}
	_, err := c.input.Write(data)
	return err
}

func (c *childProcess) resize(cols, rows int) error {
	if c == nil || c.hpc == 0 || cols <= 0 || rows <= 0 {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	return windows.ResizePseudoConsole(c.hpc, windows.Coord{X: int16(cols), Y: int16(rows)})
}

func (c *childProcess) wait() error {
	if c == nil || c.process == 0 {
		return nil
	}
	_, _ = windows.WaitForSingleObject(c.process, windows.INFINITE)
	var code uint32
	_ = windows.GetExitCodeProcess(c.process, &code)

	// Closing the pseudo console flushes and ends the output stream. It can
	// block while output is pending, so the reader keeps draining meanwhile.
	c.mu.Lock()
	hpc := c.hpc
	c.hpc = 0
	c.mu.Unlock()
	if hpc != 0 {
		closed := make(chan struct{})
		go func() { windows.ClosePseudoConsole(hpc); close(closed) }()
		select {
		case <-closed:
		case <-time.After(3 * time.Second):
		}
	}
	if c.reader != nil {
		select {
		case <-c.reader.done:
		case <-time.After(2 * time.Second):
		}
	}
	c.release()
	if code == 0 {
		return nil
	}
	return &exitStatusError{code: code}
}

// release closes every handle; the job's KILL_ON_JOB_CLOSE ends stragglers.
func (c *childProcess) release() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	if c.hpc != 0 {
		hpc := c.hpc
		c.hpc = 0
		go windows.ClosePseudoConsole(hpc)
	}
	if c.input != nil {
		_ = c.input.Close()
	}
	if c.output != nil {
		_ = c.output.Close()
	}
	for _, h := range []windows.Handle{c.thread, c.process, c.job} {
		if h != 0 {
			windows.CloseHandle(h)
		}
	}
}

func (c *childProcess) pid() int {
	if c == nil {
		return 0
	}
	return c.pidNum
}

func exitCodeFromWait(err error) int {
	if err == nil {
		return 0
	}
	var status *exitStatusError
	if errors.As(err, &status) {
		switch status.code {
		case statusControlCExit:
			return 130
		}
		if status.code > 0x7FFFFFFF {
			return int(int32(status.code))
		}
		return int(status.code)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	return 1
}

// killProcessTree force-kills pid and all of its descendants.
func killProcessTree(pid int) {
	if pid <= 0 {
		return
	}
	cmd := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	hideWindow(cmd)
	_ = cmd.Run()
}

// hideWindow keeps helper tools (taskkill, schtasks, …) from flashing a
// console window when the daemon runs without one.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

// processNames maps every live pid to its executable name.
func processNames() map[uint32]string {
	names := map[uint32]string{}
	for _, p := range processSnapshot() {
		names[p.pid] = p.exe
	}
	return names
}

type winProcess struct {
	pid, ppid uint32
	exe       string
}

func processSnapshot() []winProcess {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	var out []winProcess
	for err = windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		out = append(out, winProcess{
			pid:  entry.ProcessID,
			ppid: entry.ParentProcessID,
			exe:  windows.UTF16ToString(entry.ExeFile[:]),
		})
	}
	return out
}

var procSetConsoleCtrlHandler = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleCtrlHandler")

// allowConsoleInterrupts clears the "ignore Ctrl+C" attribute a launcher may
// have set (CREATE_NEW_PROCESS_GROUP does so implicitly). Children inherit
// it, and a server that ignores Ctrl+C can only be stopped by killing its job.
func allowConsoleInterrupts() {
	_, _, _ = procSetConsoleCtrlHandler.Call(0, 0)
}
