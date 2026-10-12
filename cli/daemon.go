package main

import (
	"fmt"
	"os"
	"strconv"
)

func runDaemon(apiPort int) error {
	if err := ensureDirs(); err != nil {
		return err
	}
	allowConsoleInterrupts()
	migrateLegacyConfig()
	store := newConfigStore(configFile())
	if apiPort == 0 {
		apiPort = store.current().APIPort
	}
	sup := newSupervisor(store, apiPort)
	srv, err := startAPI(sup, apiPort)
	if err != nil {
		return fmt.Errorf("could not bind control API on 127.0.0.1:%d: %w", apiPort, err)
	}
	osExit = os.Exit
	if err := os.WriteFile(daemonPIDFile(), []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644); err != nil {
		return err
	}
	defer os.Remove(daemonPIDFile())
	// The port actually bound: config.json may name a new one that only takes
	// effect on the next start, and the app must keep talking to this one.
	_ = os.WriteFile(daemonPortFile(), []byte(strconv.Itoa(apiPort)+"\n"), 0o644)
	defer os.Remove(daemonPortFile())

	ch := make(chan os.Signal, 1)
	notifySignals(ch)
	<-ch
	sup.terminateEverything()
	sup.close()
	srv.close()
	return nil
}

func notifySignals(ch chan<- os.Signal) {
	// installed in daemon_signals.go
	installSignalNotify(ch)
}
