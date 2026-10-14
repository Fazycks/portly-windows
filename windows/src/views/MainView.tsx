// Port of MainView.swift — the main window's NavigationSplitView: a searchable
// sidebar of temporary jobs and projects, and a detail column that switches
// between resources, ports, a project overview and a server terminal.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, isActiveState, type Project, type ServerConfig, type ServerStatus } from "../lib/api";
import { act, usePortly, useTick } from "../lib/store";
import { native, onNavigate, openExternal, reveal, usePrefs, type MainRoute } from "../lib/native";
import { Button, ContentUnavailable, Sheet, StatusDot, T, compactUptime, formatBytes, hexColor, pressureColor } from "../components/ui";
import { ProjectForm, ServerForm, TemporaryProcessForm } from "./Forms";
import { AgentOnboardingCard } from "./AgentSetup";
import ResourceDashboard from "./ResourceDashboard";
import PortsView from "./PortsView";
import ServerDetail from "./ServerDetail";
import ProjectDetail from "./ProjectDetail";
import { SidebarSearch, SidebarSearchField } from "./SidebarSearch";
import { DetailToolbar, ToolbarSlot } from "./Toolbar";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { Icon, hasMetrics, isRunning, jobStatus, memoryPressure, pressureLabel, serverURL, timeoutDisplay, type JobStatus } from "./serverInfo";
import "./MainView.css";

type Selection = MainRoute;

interface EditingServer {
  projectID: string;
  projectName: string;
  projectRoot: string;
  server: ServerConfig | null;
}

const sameSelection = (a: Selection | null, b: Selection | null) =>
  a === b || (a != null && b != null && a.kind === b.kind && ("id" in a ? a.id : "") === ("id" in b ? b.id : ""));

const SIDEBAR_MIN = 220;
const SIDEBAR_IDEAL = 250;
const SIDEBAR_MAX = 340;

export default function MainView() {
  const { status, config, connected, error } = usePortly();
  const [prefs, setPrefs, prefsLoaded] = usePrefs();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingServer, setEditingServer] = useState<EditingServer | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const [runningTemporary, setRunningTemporary] = useState(false);
  const [search, setSearch] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_IDEAL);
  const [listFocused, setListFocused] = useState(false);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  useTick(1000);

  // MARK: - Data

  const projects = useMemo(() => config?.projects ?? [], [config]);

  const runtimes = useMemo(() => {
    const map = new Map<string, ServerStatus>();
    status?.projects.forEach((p) => p.servers.forEach((s) => map.set(s.id, s)));
    status?.temporaryServers.forEach((s) => map.set(s.id, s));
    return map;
  }, [status]);
  const runtime = useCallback((id: string) => runtimes.get(id), [runtimes]);

  const temporaryIDs = useMemo(() => new Set(status?.temporaryServers.map((s) => s.id) ?? []), [status]);
  const visibleTemporaryRuntimes = useMemo(() => status?.temporaryServers.filter(isRunning) ?? [], [status]);
  const runningCount = useMemo(() => [...runtimes.values()].filter(isRunning).length, [runtimes]);

  const projectIsRunning = useCallback(
    (project: Project) => project.servers.some((s) => runtimes.get(s.id) && isActiveState(runtimes.get(s.id)!.state)),
    [runtimes],
  );

  /** Running projects float to the top; otherwise the store order is kept. */
  const sidebarProjects = useMemo(
    () =>
      projects
        .map((p, offset) => ({ p, offset, running: projectIsRunning(p) }))
        .sort((l, r) => (l.running !== r.running ? (l.running ? -1 : 1) : l.offset - r.offset))
        .map((x) => x.p),
    [projects, projectIsRunning],
  );
  const runningSignature = projects.map((p) => (projectIsRunning(p) ? "1" : "0")).join("");

  const filteredSidebarProjects = useMemo(() => SidebarSearch.filterProjects(sidebarProjects, search), [sidebarProjects, search]);
  const filteredTemporaryRuntimes = useMemo(
    () => visibleTemporaryRuntimes.filter((s) => SidebarSearch.matchesServer(s, search)),
    [visibleTemporaryRuntimes, search],
  );
  const showEmptySearch = SidebarSearch.isActive(search) && filteredTemporaryRuntimes.length === 0 && filteredSidebarProjects.length === 0;

  /** Search returns truncated copies. Mutations and "open" must use the store value. */
  const storedProject = (id: string) => projects.find((p) => p.id === id);
  const projectContaining = (serverId: string) => projects.find((p) => p.servers.some((s) => s.id === serverId));

  // MARK: - Selection plumbing

  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    onNavigate((route) => setSelection(route))
      .then((u) => { if (cancelled) u(); else un = u; })
      .catch(() => {});
    return () => { cancelled = true; un?.(); };
  }, []);

  // Settings… (⌘, on macOS). Capture phase: the terminal would swallow it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "," || !e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      void native.openSettings();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // clearFinishedTemporarySelection
  useEffect(() => {
    if (selection?.kind !== "server" || !temporaryIDs.has(selection.id)) return;
    const s = runtimes.get(selection.id);
    if (s && !isRunning(s)) setSelection(null);
  }, [status, selection, temporaryIDs, runtimes]);

  const activateFirstMatch = () => {
    const match = SidebarSearch.firstMatch(visibleTemporaryRuntimes, sidebarProjects, search);
    if (match) setSelection(match);
  };

  const openProject = (project: Project) => {
    const url = project.servers.map((s) => runtimes.get(s.id)).map((s) => (s ? serverURL(s) : null)).find(Boolean);
    if (url) void openExternal(url);
  };

  const editServer = (project: Project, server: ServerConfig | null) =>
    setEditingServer({ projectID: project.id, projectName: project.name, projectRoot: project.root, server });

  // MARK: - Menus

  const projectMenu = (project: Project): MenuItem[] => [
    { label: "Start All", onClick: () => void act(() => api.start({ project: project.id })) },
    { label: "Stop All", onClick: () => void act(() => api.stop({ project: project.id })) },
    "divider",
    { label: "Add Server…", onClick: () => editServer(project, null) },
    { label: "Edit Project…", onClick: () => setEditingProject(project) },
    { label: "Show in File Explorer", onClick: () => void reveal(project.root).catch(() => {}) },
    "divider",
    { label: "Remove Project", onClick: () => void act(() => api.removeProject(project.id)) },
  ];

  const serverMenu = (s: ServerStatus, project: Project): MenuItem[] => {
    const url = serverURL(s);
    const config = project.servers.find((x) => x.id === s.id) ?? null;
    return [
      ...(isRunning(s)
        ? [
            { label: "Stop", onClick: () => void act(() => api.stop({ server: s.id })) },
            { label: "Restart", onClick: () => void act(() => api.restart({ server: s.id })) },
          ]
        : [{ label: "Start", onClick: () => void act(() => api.start({ server: s.id })) }]),
      "divider",
      ...(url ? [{ label: `Open ${url}`, onClick: () => void openExternal(url) }] : []),
      { label: "Edit…", onClick: () => editServer(project, config) },
      "divider",
      { label: "Remove Server", onClick: () => void act(() => api.removeServer(s.id)) },
    ];
  };

  const temporaryServerMenu = (s: ServerStatus): MenuItem[] => {
    const url = serverURL(s);
    const remove = () => void act(() => api.removeServer(s.id));
    const start = () => void act(() => api.start({ server: s.id }));
    const items: MenuItem[] = isRunning(s)
      ? [{ label: "Stop and Remove", onClick: remove }, { label: "Restart", onClick: () => void act(() => api.restart({ server: s.id })) }]
      : s.state === "failed"
        ? [{ label: "Retry", onClick: start }, "divider", { label: "Remove", onClick: remove }]
        : [{ label: "Run Again", onClick: start }, "divider", { label: "Remove", onClick: remove }];
    if (url) items.push("divider", { label: `Open ${url}`, onClick: () => void openExternal(url) });
    return items;
  };

  // MARK: - Keyboard

  const selectableOrder = useMemo<Selection[]>(() => {
    const out: Selection[] = filteredTemporaryRuntimes.map((s) => ({ kind: "server", id: s.id }));
    for (const p of filteredSidebarProjects) {
      out.push({ kind: "project", id: p.id });
      for (const s of p.servers) if (runtimes.has(s.id)) out.push({ kind: "server", id: s.id });
    }
    return out;
  }, [filteredTemporaryRuntimes, filteredSidebarProjects, runtimes]);

  const onListKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      if (SidebarSearch.isActive(search)) setSearch("");
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (selectableOrder.length === 0) return;
    const i = selectableOrder.findIndex((s) => sameSelection(s, selection));
    const next = i < 0
      ? (e.key === "ArrowDown" ? 0 : selectableOrder.length - 1)
      : Math.max(0, Math.min(selectableOrder.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
    setSelection(selectableOrder[next]);
  };

  useEffect(() => {
    const el = listRef.current?.querySelector(".sb-row.selected");
    (el as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  }, [selection]);

  // MARK: - Reorder animation (Motion.reorder)

  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const lastTops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    sectionRefs.current.forEach((el, id) => {
      const old = lastTops.current.get(id);
      if (old == null) return;
      const delta = old - el.offsetTop;
      if (!delta || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${delta}px)`;
      void el.offsetHeight;
      el.style.transition = "transform 280ms var(--ease-reorder)";
      el.style.transform = "";
    });
  }, [runningSignature]);
  useLayoutEffect(() => {
    const tops = new Map<string, number>();
    sectionRefs.current.forEach((el, id) => tops.set(id, el.offsetTop));
    lastTops.current = tops;
  });

  // MARK: - Sidebar resize

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const move = (ev: MouseEvent) =>
      setSidebarWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // MARK: - Rendering

  const rowProps = (sel: Selection) => ({
    selected: sameSelection(selection, sel),
    onSelect: () => {
      setSelection(sel);
      listRef.current?.focus({ preventScroll: true });
    },
  });

  const sidebar = (
    <aside className="sidebar" style={{ width: sidebarWidth }}>
      {/* sidebarSearch */}
      <div className="sidebar-search">
        <SidebarSearchField text={search} onChange={setSearch} inputRef={searchRef} onSubmit={activateFirstMatch} />
        <button
          className="kill-all"
          disabled={runningCount === 0}
          title={runningCount === 0 ? "No running processes" : "Stop every running server and temporary process"}
          aria-label="Kill All"
          aria-description="Stops every running server and temporary process"
          onClick={() => void act(() => api.stopAll())}
        >
          <Icon name="stop.fill" size={11} />
          <span>Kill All</span>
        </button>
        {/* The app menu's Settings… (⌘,): reachable even when the tray icon is hidden. */}
        <button
          className="sidebar-settings"
          title="Settings (Ctrl+,)"
          aria-label="Settings"
          onClick={() => void native.openSettings()}
        >
          <Icon name="gearshape" size={13} />
        </button>
      </div>

      <div className="sidebar-list-wrap">
        <div
          ref={listRef}
          className={`sidebar-list${listFocused ? " focused" : ""}`}
          tabIndex={0}
          role="listbox"
          onFocus={() => setListFocused(true)}
          onBlur={() => setListFocused(false)}
          onKeyDown={onListKeyDown}
        >
          {filteredTemporaryRuntimes.length > 0 && (
            <section className="sb-section">
              <div className="sb-section-header" title="Supervised background jobs currently running with a timeout">
                <Icon name="clock.badge" size={11} />
                <span>Temporary</span>
              </div>
              {filteredTemporaryRuntimes.map((s) => (
                <ServerRow
                  key={s.id}
                  server={s}
                  {...rowProps({ kind: "server", id: s.id })}
                  onContextMenu={(e) => menu.open(e, temporaryServerMenu(s))}
                />
              ))}
            </section>
          )}

          {filteredSidebarProjects.map((project) => (
            <section
              key={project.id}
              className="sb-section"
              ref={(el) => {
                if (el) sectionRefs.current.set(project.id, el);
                else sectionRefs.current.delete(project.id);
              }}
            >
              <ProjectHeader
                project={project}
                {...rowProps({ kind: "project", id: project.id })}
                onDoubleClick={() => {
                  const p = storedProject(project.id);
                  if (p) openProject(p);
                }}
                onContextMenu={(e) => {
                  const p = storedProject(project.id);
                  if (p) menu.open(e, projectMenu(p));
                }}
              />
              {project.servers.map((server) => {
                const s = runtimes.get(server.id);
                if (!s) return null;
                return (
                  <ServerRow
                    key={server.id}
                    server={s}
                    nested
                    {...rowProps({ kind: "server", id: server.id })}
                    onContextMenu={(e) => {
                      const p = storedProject(project.id);
                      if (p) menu.open(e, serverMenu(s, p));
                    }}
                  />
                );
              })}
            </section>
          ))}
        </div>

        {showEmptySearch && (
          <div className="sidebar-empty-search">
            <ContentUnavailable
              symbol="magnifyingglass"
              title={`No Results for “${search}”`}
              description="Check the spelling or try a new search."
            />
          </div>
        )}
      </div>

      {/* sidebarActions */}
      <div className="sidebar-actions" style={T.bodyMedium}>
        <DestinationButton
          title="Resources"
          symbol="chart.xyaxis.line"
          selected={selection?.kind === "resources"}
          hint="Shows live memory, smart diagnostics, safe fixes, and heavy processes inside or outside Portly"
          onClick={() => setSelection({ kind: "resources" })}
        />
        <DestinationButton
          title="View Ports"
          symbol="network"
          selected={selection?.kind === "ports"}
          hint="Shows every listening TCP port on this PC"
          onClick={() => setSelection({ kind: "ports" })}
        />
        <Button
          size="large"
          className="sidebar-action-button"
          aria-label="Run temporary process"
          aria-description="For small previews and one-off work that should not create a permanent project"
          onClick={() => setRunningTemporary(true)}
        >
          <Icon name="clock.badge.plus" size={13} />
          <span>Run Temporary…</span>
        </Button>
        <Button
          variant="prominent"
          size="large"
          className="sidebar-action-button"
          aria-label="Add project"
          onClick={() => setAddingProject(true)}
        >
          <Icon name="plus" size={13} />
          <span>Add Project</span>
        </Button>
      </div>

      <div className="sidebar-resizer" onMouseDown={startResize} />
    </aside>
  );

  const emptyDetail = (message: string) => (
    <>
      <DetailToolbar title="Portly" />
      <div className="empty-detail">
        <Icon name="bolt.horizontal.circle" size={32} strokeWidth={1.25} className="tertiary" />
        <div className="secondary">{message}</div>
      </div>
    </>
  );

  const detail = (() => {
    if (!connected && error) {
      return (
        <>
          <DetailToolbar title="Portly" />
          <ContentUnavailable
            symbol="network.slash"
            title="Portly isn’t running"
            description="The Portly service isn’t responding. It will reconnect automatically when it’s back."
          />
        </>
      );
    }
    switch (selection?.kind) {
      case "resources":
        return (
          <>
            <DetailToolbar title="Resources" />
            <ResourceDashboard />
          </>
        );
      case "ports":
        return (
          <>
            <DetailToolbar title="Ports" />
            <PortsView />
          </>
        );
      case "server": {
        const id = selection.id;
        const s = runtimes.get(id);
        if (!s) return emptyDetail("This server no longer exists.");
        const project = projectContaining(id);
        const serverConfig = project?.servers.find((x) => x.id === id) ?? null;
        return (
          <ServerDetail
            key={id}
            server={s}
            actions={serverConfig?.actions ?? []}
            onEdit={temporaryIDs.has(id) || !project ? null : () => editServer(project, serverConfig)}
            onShowResources={() => setSelection({ kind: "resources" })}
          />
        );
      }
      case "project": {
        const project = projects.find((p) => p.id === selection.id);
        if (!project) return emptyDetail("This project no longer exists.");
        return (
          <ProjectDetail
            project={project}
            runtime={runtime}
            onAddServer={() => editServer(project, null)}
            onEdit={() => setEditingProject(project)}
            onSelectServer={(serverID) => setSelection({ kind: "server", id: serverID })}
          />
        );
      }
      default:
        return emptyDetail(
          projects.length === 0 && visibleTemporaryRuntimes.length === 0
            ? "Run a temporary process or add a project to get started."
            : "Select a server to see its terminal.",
        );
    }
  })();

  return (
    <div className="main-view" style={T.body}>
      {sidebar}

      <main className="detail-column">
        <div ref={setToolbarSlot} className="detail-toolbar-slot" />
        {prefsLoaded && !prefs.agentOnboardingDismissed && (
          <AgentOnboardingCard onDismiss={() => void setPrefs({ agentOnboardingDismissed: true })} />
        )}
        <div className="detail-content">
          <ToolbarSlot.Provider value={toolbarSlot}>{toolbarSlot && detail}</ToolbarSlot.Provider>
        </div>
      </main>

      {menu.element}

      <Sheet open={addingProject} onClose={() => setAddingProject(false)} width={480}>
        {addingProject && (
          <ProjectForm
            project={null}
            takenColors={projects.map((p) => p.color)}
            onDone={(projectId) => {
              setAddingProject(false);
              if (projectId) setSelection({ kind: "project", id: projectId });
            }}
          />
        )}
      </Sheet>

      <Sheet open={runningTemporary} onClose={() => setRunningTemporary(false)} width={540}>
        {runningTemporary && (
          <TemporaryProcessForm
            onDone={(jobId) => {
              setRunningTemporary(false);
              if (jobId) setSelection({ kind: "server", id: jobId });
            }}
          />
        )}
      </Sheet>

      <Sheet open={editingProject != null} onClose={() => setEditingProject(null)} width={480}>
        {editingProject && (
          <ProjectForm
            key={editingProject.id}
            project={editingProject}
            takenColors={projects.filter((p) => p.id !== editingProject.id).map((p) => p.color)}
            onDone={() => setEditingProject(null)}
          />
        )}
      </Sheet>

      <Sheet open={editingServer != null} onClose={() => setEditingServer(null)} width={520}>
        {editingServer && (
          <ServerForm
            key={(editingServer.server?.id ?? "new") + editingServer.projectID}
            server={editingServer.server}
            projectID={editingServer.projectID}
            projectName={editingServer.projectName}
            projectRoot={editingServer.projectRoot}
            onDone={(serverId) => {
              const wasNew = editingServer.server == null || editingServer.server.id !== serverId;
              setEditingServer(null);
              if (serverId && wasNew) setSelection({ kind: "server", id: serverId });
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

// MARK: - Sidebar rows

type RowEvents = {
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
};

function ProjectHeader({ project, selected, onSelect, onContextMenu, onDoubleClick }: { project: Project } & RowEvents) {
  const color = hexColor(project.color);
  return (
    <div
      className={`sb-row sb-project${selected ? " selected" : ""}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(e) => { if (e.button === 0) onSelect(); }}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <span className="sb-project-icon" style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
        <Icon name={project.icon} size={10.5} strokeWidth={2.5} />
      </span>
      <span className="sb-project-name" style={T.project}>{project.name}</span>
    </div>
  );
}

function ServerRow({ server, nested, selected, onSelect, onContextMenu }: { server: ServerStatus; nested?: boolean } & RowEvents) {
  const job = jobStatus(server);
  const pressure = hasMetrics(server) ? memoryPressure(server.memoryBytes ?? 0) : null;
  const memoryText = formatBytes(server.memoryBytes ?? 0);
  return (
    <div
      className={`sb-row sb-server${nested ? " nested" : ""}${selected ? " selected" : ""}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(e) => { if (e.button === 0) onSelect(); }}
      onContextMenu={onContextMenu}
    >
      <StatusDot state={server.state} />
      <div className="sb-server-texts">
        <div className="sb-server-name" style={T.bodyMedium}>{server.name}</div>
        <div className="sb-server-meta sb-secondary" style={T.metadata}>
          {server.port != null && <span>localhost:{server.port}</span>}
          {job && <span>{jobLabel(job)}</span>}
          {pressure && (
            <>
              <span className="sb-meta-spacer" />
              <span
                className="sb-memory"
                style={{ color: pressureColor(pressure) }}
                title={`Footprint: ${memoryText} — ${pressureLabel(pressure)}. Open the server for full resource details.`}
                aria-label={`Memory footprint ${memoryText}, ${pressureLabel(pressure)} use`}
              >
                <Icon name="memorychip" size={10} strokeWidth={2.2} />
              </span>
            </>
          )}
        </div>
      </div>
      {server.startedAt && isRunning(server) && (
        <span className="sb-uptime sb-tertiary digits" style={T.metadata}>{compactUptime(server.startedAt)}</span>
      )}
    </div>
  );
}

function jobLabel(job: JobStatus): string {
  switch (job.state) {
    case "running": return `timeout ${timeoutDisplay(job.timeoutSeconds)}`;
    case "succeeded": return "succeeded";
    case "failed": return job.exitCode != null ? `failed (exit ${job.exitCode})` : "failed";
    case "timedOut": return "timed out";
    case "stopped": return "stopped";
  }
}

function DestinationButton({ title, symbol, selected, hint, onClick }: {
  title: string; symbol: string; selected: boolean; hint: string; onClick: () => void;
}) {
  return (
    <button
      className={`destination-button${selected ? " selected" : ""}`}
      aria-label={title}
      aria-description={hint}
      onClick={onClick}
    >
      <Icon name={symbol} size={13} />
      <span className="destination-title">{title}</span>
      <Icon name="chevron.right" size={9} strokeWidth={2.8} className="secondary" />
    </button>
  );
}
