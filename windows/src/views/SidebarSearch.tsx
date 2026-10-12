// Port of SidebarSearch.swift — substring filter for the main-window sidebar.
// Matching is case-insensitive and ignores surrounding whitespace, same as the
// Ports screen.
import { useEffect, type RefObject } from "react";
import { Icon } from "./serverInfo";

/** The fields search reads from a ServerConfig (or a temporary job's status). */
export interface SearchableServer { id: string; name: string; command: string; port: number | null }
export interface SearchableProject<S extends SearchableServer = SearchableServer> { id: string; name: string; root: string; servers: S[] }

export type SidebarSearchMatch = { kind: "project"; id: string } | { kind: "server"; id: string };

const normalized = (query: string) => query.trim().toLowerCase();
const contains = (value: string, needle: string) => value.toLowerCase().includes(needle);
const lastPathComponent = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

function projectMatches(project: SearchableProject, needle: string) {
  return contains(project.name, needle) || contains(lastPathComponent(project.root), needle);
}

function serverMatches(server: SearchableServer, needle: string) {
  if (contains(server.name, needle) || contains(server.command, needle)) return true;
  if (server.port == null) return false;
  return String(server.port).includes(needle) || contains(`localhost:${server.port}`, needle);
}

export const SidebarSearch = {
  isActive(query: string) {
    return normalized(query) !== "";
  },

  filterProjects<S extends SearchableServer, P extends SearchableProject<S>>(projects: P[], query: string): P[] {
    const needle = normalized(query);
    if (!needle) return projects;
    return projects.flatMap((project) => {
      if (projectMatches(project, needle)) return [project];
      const servers = project.servers.filter((s) => serverMatches(s, needle));
      if (servers.length === 0) return [];
      // Display copy only. Never write this value back to the store.
      return [{ ...project, servers }];
    });
  },

  matchesServer(server: SearchableServer, query: string, project?: SearchableProject) {
    const needle = normalized(query);
    if (!needle) return true;
    if (project && projectMatches(project, needle)) return true;
    return serverMatches(server, needle);
  },

  firstMatch(temporaryServers: SearchableServer[], projects: SearchableProject[], query: string): SidebarSearchMatch | null {
    if (!SidebarSearch.isActive(query)) return null;
    const temp = temporaryServers.find((s) => SidebarSearch.matchesServer(s, query));
    if (temp) return { kind: "server", id: temp.id };
    const project = SidebarSearch.filterProjects(projects, query)[0];
    if (!project) return null;
    if (project.servers[0]) return { kind: "server", id: project.servers[0].id };
    return { kind: "project", id: project.id };
  },
};

export function SidebarSearchField({ text, onChange, inputRef, onSubmit }: {
  text: string;
  onChange: (text: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
}) {
  // Hidden "Search" button with ⌘F → Ctrl+F.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inputRef]);

  return (
    <div className="sidebar-search-field" title="Filter the sidebar by project, server, or port" onMouseDown={(e) => {
      if (e.target === e.currentTarget) { e.preventDefault(); inputRef.current?.focus(); }
    }}>
      <Icon name="magnifyingglass" size={12} strokeWidth={2.5} className="secondary" />
      <input
        ref={inputRef}
        value={text}
        placeholder="Search projects"
        spellCheck={false}
        aria-label="Search projects and servers"
        aria-description="Filters the sidebar by project, server, command, or port. Press Return to select the first match."
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onSubmit(); }
        }}
      />
      {SidebarSearch.isActive(text) && (
        <button
          className="sidebar-search-clear"
          aria-label="Clear search"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onChange(""); inputRef.current?.focus(); }}
        >
          <Icon name="xmark.circle.fill" size={12} />
        </button>
      )}
    </div>
  );
}
