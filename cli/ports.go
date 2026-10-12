package main

import (
	"fmt"
	"os"
	"strings"
)

type listener struct {
	Port    int
	PID     int
	Command string
	User    string
	Address string
}

type stopOutcome struct {
	Description     string
	ProcessID       *int
	DockerContainer *dockerContainer
}

func occupantOf(port int) *listener { return platformOccupant(port) }

func isListening(port int) bool { return occupantOf(port) != nil }

func stopOccupant(port int, expectedPID *int) (stopOutcome, error) {
	occ := occupantOf(port)
	if occ == nil {
		return stopOutcome{}, fmt.Errorf("The port is already free.")
	}
	if expectedPID != nil && occ.PID != *expectedPID {
		return stopOutcome{}, fmt.Errorf("The listener changed before Portly could stop it. Refresh and try again.")
	}
	if occ.PID == os.Getpid() {
		return stopOutcome{}, fmt.Errorf("That is Portly's own control API. Use portly quit instead.")
	}
	if container := dockerContainerPublishing(port); container != nil {
		if err := stopDockerContainer(*container); err != nil {
			return stopOutcome{}, err
		}
		return stopOutcome{
			Description:     "Docker container " + container.displayName(),
			DockerContainer: container,
		}, nil
	}
	if isDockerDaemonCommand(occ.Command) {
		return stopOutcome{}, fmt.Errorf("Refusing to signal the Docker daemon. Stop the published container instead.")
	}
	if err := terminatePID(occ.PID); err != nil {
		return stopOutcome{}, fmt.Errorf("Process %d refused the stop request.", occ.PID)
	}
	pid := occ.PID
	return stopOutcome{
		Description: fmt.Sprintf("%s (pid %d)", occ.Command, occ.PID),
		ProcessID:   &pid,
	}, nil
}

func extractAfter(s, prefix string) int {
	i := strings.Index(s, prefix)
	if i < 0 {
		return 0
	}
	rest := s[i+len(prefix):]
	n := 0
	for _, r := range rest {
		if r < '0' || r > '9' {
			break
		}
		n = n*10 + int(r-'0')
	}
	return n
}

func extractBetween(s, start, end string) string {
	i := strings.Index(s, start)
	if i < 0 {
		return ""
	}
	rest := s[i+len(start):]
	j := strings.Index(rest, end)
	if j < 0 {
		return ""
	}
	return rest[:j]
}

func currentUser() string {
	for _, key := range []string{"USER", "USERNAME"} {
		if u := os.Getenv(key); u != "" {
			return u
		}
	}
	return ""
}
