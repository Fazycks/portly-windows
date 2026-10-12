package main

import (
	"os"
	"path/filepath"
	"runtime"
)

// legacyConfigFile is where Portly builds for Windows before this one kept
// their settings (the Unix layout, under the user profile).
func legacyConfigFile() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "portly", "config.json")
}

// migrateLegacyConfig imports projects and servers from an earlier install on
// the first run. Only that data moves; settings start from today's defaults
// and anything unreadable is left alone.
func migrateLegacyConfig() {
	if runtime.GOOS != "windows" || os.Getenv("PORTLY_HOME") != "" {
		return
	}
	migrateConfigFrom(legacyConfigFile(), configFile())
}

func migrateConfigFrom(legacy, target string) bool {
	if legacy == "" || fileExists(target) {
		return false
	}
	old, ok := readConfig(legacy)
	if !ok || len(old.Projects) == 0 {
		return false
	}
	cfg := defaultConfig()
	for _, project := range old.Projects {
		if project.Name == "" || project.Root == "" {
			continue
		}
		if project.Icon == "" {
			project.Icon = defaultProjectIcon
		}
		if project.MemoryLimitMode == "" {
			project.MemoryLimitMode = MemoryInherit
		}
		servers := project.Servers[:0]
		for _, server := range project.Servers {
			if server.Name != "" && server.Command != "" {
				servers = append(servers, server)
			}
		}
		project.Servers = servers
		cfg.Projects = append(cfg.Projects, project)
	}
	if len(cfg.Projects) == 0 {
		return false
	}
	return writeConfig(target, cfg) == nil
}
