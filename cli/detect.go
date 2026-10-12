package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// detectedCommand is a guessed dev server for the Add Server form, ported
// from CommandDetector.swift. Everything here is best-effort: a folder we
// cannot make sense of yields no suggestions.
type detectedCommand struct {
	Name      string  `json:"name"`
	Command   string  `json:"command"`
	Port      *int    `json:"port"`
	Directory *string `json:"directory"`
	Source    string  `json:"source"`

	supportsPortArgument bool
}

func (d detectedCommand) id() string {
	if d.Directory != nil {
		return d.Command + *d.Directory
	}
	return d.Command
}

func detectCommands(root string, reserved map[int]bool) []detectedCommand {
	base := filepath.Clean(expandPath(root))
	if !dirExists(base) {
		return []detectedCommand{}
	}
	found := detectNode(base, base)
	// A monorepo hides its real servers one level down.
	if len(found) == 0 || isWorkspaceRoot(base) {
		for _, dir := range workspaceCandidates(base) {
			found = append(found, detectNode(dir, base)...)
		}
	}
	found = append(found, detectOthers(base, base)...)

	seen := map[string]bool{}
	available := map[int]int{}
	out := []detectedCommand{}
	for _, s := range found {
		if seen[s.id()] {
			continue
		}
		seen[s.id()] = true
		if s.Port != nil {
			port := *s.Port
			next, ok := available[port]
			if !ok {
				next = nextFreePort(port, reserved)
				available[port] = next
			}
			if next != port && s.supportsPortArgument {
				s.Command += " -- --port " + strconv.Itoa(next)
			}
			s.Port = &next
		}
		out = append(out, s)
	}
	return out
}

func nextFreePort(port int, reserved map[int]bool) int {
	for candidate := port; candidate <= 65535; candidate++ {
		if !reserved[candidate] && occupantOf(candidate) == nil {
			return candidate
		}
	}
	return port
}

func readPackageJSON(dir string) map[string]any {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return nil
	}
	var parsed map[string]any
	if json.Unmarshal(data, &parsed) != nil {
		return nil
	}
	return parsed
}

func detectNode(dir, base string) []detectedCommand {
	pkg := readPackageJSON(dir)
	if pkg == nil {
		return nil
	}
	scripts := map[string]string{}
	if raw, ok := pkg["scripts"].(map[string]any); ok {
		for k, v := range raw {
			if s, ok := v.(string); ok {
				scripts[k] = s
			}
		}
	}
	if len(scripts) == 0 {
		return nil
	}
	runner := packageManager(dir, base)
	deps := dependencyNames(pkg)
	envPort := portFromEnvFiles(dir)
	relative := relativeDir(dir, base)
	label := "package.json"
	if relative != nil {
		label = *relative + "/package.json"
	}
	var out []detectedCommand
	for _, key := range devScriptNames(scripts) {
		script := scripts[key]
		configured := portFromScript(script)
		if configured == nil {
			configured = envPort
		}
		framework := frameworkPort(deps, script)
		port := configured
		if port == nil {
			port = framework
		}
		out = append(out, detectedCommand{
			Name:                 serverNameFor(key, relative),
			Command:              runner + " " + key,
			Port:                 port,
			Directory:            relative,
			Source:               label,
			supportsPortArgument: configured == nil && framework != nil,
		})
	}
	return out
}

// devScriptNames orders `dev` and `start` first, then namespaced servers
// (`dev:api`, `start:worker`), capped at eight.
func devScriptNames(scripts map[string]string) []string {
	var ordered []string
	for _, preferred := range []string{"dev", "start", "serve", "develop", "watch"} {
		if _, ok := scripts[preferred]; ok {
			ordered = append(ordered, preferred)
		}
	}
	var namespaced []string
	for key := range scripts {
		if strings.HasPrefix(key, "dev:") || strings.HasPrefix(key, "start:") || strings.HasPrefix(key, "serve:") {
			namespaced = append(namespaced, key)
		}
	}
	sort.Strings(namespaced)
	ordered = append(ordered, namespaced...)
	if len(ordered) > 8 {
		ordered = ordered[:8]
	}
	return ordered
}

var lockfiles = []struct{ file, command string }{
	{"pnpm-lock.yaml", "pnpm"},
	{"bun.lockb", "bun run"},
	{"bun.lock", "bun run"},
	{"yarn.lock", "yarn"},
	{"package-lock.json", "npm run"},
}

// packageManager reads the lockfile of the package, its parent, or the
// workspace root that apps/<name> packages inherit from.
func packageManager(dir, base string) string {
	for _, candidate := range []string{dir, filepath.Dir(dir), base} {
		for _, lock := range lockfiles {
			if fileExists(filepath.Join(candidate, lock.file)) {
				return lock.command
			}
		}
	}
	return "npm run"
}

func dependencyNames(pkg map[string]any) map[string]bool {
	names := map[string]bool{}
	for _, key := range []string{"dependencies", "devDependencies"} {
		if deps, ok := pkg[key].(map[string]any); ok {
			for name := range deps {
				names[name] = true
			}
		}
	}
	return names
}

func detectOthers(dir, base string) []detectedCommand {
	has := func(name string) bool { return fileExists(filepath.Join(dir, name)) }
	relative := relativeDir(dir, base)
	port := func(p int) *int { return &p }
	var out []detectedCommand
	add := func(name, command string, p *int, source string) {
		out = append(out, detectedCommand{Name: name, Command: command, Port: p, Directory: relative, Source: source})
	}
	if has("Cargo.toml") {
		add("server", "cargo run", nil, "Cargo.toml")
	}
	if has("go.mod") {
		add("server", "go run .", nil, "go.mod")
	}
	if has("manage.py") {
		add("django", "python manage.py runserver", port(8000), "manage.py")
	}
	if has("Gemfile") && has("config.ru") {
		add("rails", "bin/rails server", port(3000), "Gemfile")
	}
	if has("docker-compose.yml") || has("compose.yml") {
		add("compose", "docker compose up", nil, "docker-compose")
	}
	if data, err := os.ReadFile(filepath.Join(dir, "Procfile")); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			name, command, ok := strings.Cut(line, ":")
			command = strings.TrimSpace(command)
			if !ok || command == "" {
				continue
			}
			add(strings.TrimSpace(name), command, portFromScript(command), "Procfile")
		}
	}
	return out
}

var scriptPortPatterns = []*regexp.Regexp{
	regexp.MustCompile(`PORT=\$\{PORT:-(\d{2,5})\}`),
	regexp.MustCompile(`--port[= ]+(\d{2,5})`),
	regexp.MustCompile(`(?:^|\s)-p[= ]+(\d{2,5})`),
	regexp.MustCompile(`PORT[= ]+(\d{2,5})`),
}

// portFromScript reads `--port 3001`, `-p 3001` or `PORT=3001`.
func portFromScript(script string) *int {
	for _, re := range scriptPortPatterns {
		if m := re.FindStringSubmatch(script); m != nil {
			if port, err := strconv.Atoi(m[1]); err == nil {
				return &port
			}
		}
	}
	return nil
}

func portFromEnvFiles(dir string) *int {
	for _, name := range []string{".env.local", ".env.development", ".env"} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			trimmed := strings.TrimSpace(line)
			if !strings.HasPrefix(trimmed, "PORT=") {
				continue
			}
			value := strings.Trim(strings.TrimPrefix(trimmed, "PORT="), "\"' ")
			if port, err := strconv.Atoi(value); err == nil {
				return &port
			}
		}
	}
	return nil
}

var frameworkPorts = []struct {
	dependency string
	port       int
}{
	{"astro", 4321},
	{"@remix-run/dev", 3000},
	{"next", 3000},
	{"nuxt", 3000},
	{"@sveltejs/kit", 5173},
	{"vite", 5173},
	{"expo", 8081},
	{"@angular/cli", 4200},
	{"react-scripts", 3000},
	{"convex", 3210},
}

func frameworkPort(deps map[string]bool, script string) *int {
	for _, fw := range frameworkPorts {
		if deps[fw.dependency] || strings.Contains(script, fw.dependency) {
			port := fw.port
			return &port
		}
	}
	return nil
}

func isWorkspaceRoot(dir string) bool {
	if fileExists(filepath.Join(dir, "pnpm-workspace.yaml")) {
		return true
	}
	pkg := readPackageJSON(dir)
	_, ok := pkg["workspaces"]
	return ok
}

func workspaceCandidates(base string) []string {
	var dirs []string
	for _, container := range []string{"apps", "packages", "services"} {
		entries, err := os.ReadDir(filepath.Join(base, container))
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				dirs = append(dirs, filepath.Join(base, container, entry.Name()))
			}
		}
	}
	if len(dirs) > 12 {
		dirs = dirs[:12]
	}
	return dirs
}

// serverNameFor uses the folder in a monorepo, since that is what tells
// servers apart there, not "dev".
func serverNameFor(script string, directory *string) string {
	if directory != nil {
		parts := strings.Split(*directory, "/")
		leaf := parts[len(parts)-1]
		if script == "dev" || script == "start" {
			return leaf
		}
		return leaf + "-" + strings.ReplaceAll(script, ":", "-")
	}
	return strings.ReplaceAll(script, ":", "-")
}

// relativeDir returns dir relative to base with forward slashes, or nil for
// the base itself.
func relativeDir(dir, base string) *string {
	rel, err := filepath.Rel(base, dir)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return nil
	}
	rel = filepath.ToSlash(rel)
	return &rel
}
