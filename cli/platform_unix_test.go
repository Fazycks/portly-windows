//go:build !windows

package main

const (
	testEchoExit3 = "printf 'hello-portly\\n'; exit 3"
	testPython    = "python3"
	testSleep     = "sleep 30"
)
