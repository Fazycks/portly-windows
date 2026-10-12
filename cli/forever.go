package main

import (
	"os"
	"time"
)

type foreverState struct {
	Enabled          bool   `json:"enabled"`
	Loaded           bool   `json:"loaded"`
	Label            string `json:"label"`
	Unit             string `json:"unit"`
	DaemonExecutable string `json:"daemonExecutable"`
}

func snapshotActiveServers(c *portlyClient) []string {
	if !c.reachable(time.Second) {
		return nil
	}
	var status PortlyStatus
	if err := c.request("GET", "status", nil, &status, false); err != nil {
		return nil
	}
	var ids []string
	for _, project := range status.Projects {
		for _, server := range project.Servers {
			if server.State != StateStopped && server.State != StateFailed {
				ids = append(ids, server.ID)
			}
		}
	}
	return ids
}

func restoreServers(c *portlyClient, ids []string) {
	for _, id := range ids {
		_ = c.post("start", targetRequest{Server: &id}, &actionResponse{})
	}
}

func waitUntilUnreachable(c *portlyClient) {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && c.reachable(300*time.Millisecond) {
		time.Sleep(200 * time.Millisecond)
	}
}

func waitForAPI(c *portlyClient) bool {
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if c.reachable(500 * time.Millisecond) {
			return true
		}
		time.Sleep(300 * time.Millisecond)
	}
	return false
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
