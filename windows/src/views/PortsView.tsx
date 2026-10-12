// Port of Sources/PortlyApp/PortsView.swift (PortsView, SystemPortsCard, PortGroupCard,
// PortRow, PortKindBadge, ActivePort, ActivePortGroup, ActivePortsModel).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { api, type Listener, type PortlyStatus, type ProjectStatus, type ServerStatus } from "../lib/api";
import { usePortly } from "../lib/store";
import { openExternal } from "../lib/native";
import { Symbol } from "../lib/symbols";
import { Alert, Button, ContentUnavailable, Divider, ProgressSpinner, TextField, hexColor } from "../components/ui";
import "./PortsView.css";

// ---------- model types ----------

type Kind = "managed" | "portly" | "external" | "system";
const kindLabel: Record<Kind, string> = { managed: "Managed", portly: "Portly", external: "External", system: "Protected" };
const kindForeground: Record<Kind, string> = {
  managed: "var(--sys-green)",
  portly: "var(--sys-blue)",
  external: "var(--secondary-label)",
  system: "var(--secondary-label)",
};

interface ActivePort {
  id: string;
  port: number;
  pid: number;
  command: string;
  user: string;
  workingDirectory: string | null;
  applicationName: string;
  displayName: string;
  kind: Kind;
  serverID: string | null;
  isPrimaryPort: boolean;
}

const isOtherPort = (p: ActivePort) => !p.isPrimaryPort && (p.kind === "managed" || p.kind === "external");
const canOpen = (p: ActivePort) => !isOtherPort(p) && (p.kind === "managed" || p.kind === "external");
const canStop = canOpen;
const badgeLabel = (p: ActivePort) => (isOtherPort(p) ? "Other port" : kindLabel[p.kind]);
const badgeForeground = (p: ActivePort) => (isOtherPort(p) ? "var(--secondary-label)" : kindForeground[p.kind]);
const processDetail = (p: ActivePort) => [p.command, `PID ${p.pid}`, ...(p.user ? [p.user] : [])].join(" · ");

interface ActivePortGroup {
  id: string;
  name: string;
  detail: string;
  icon: string;
  color: string;
  rank: number;
  ports: ActivePort[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function portCounts(ports: ActivePort[]) {
  return {
    managed: new Set(ports.filter((p) => p.kind === "managed").map((p) => p.serverID).filter((id) => id != null)).size,
    otherPorts: ports.filter(isOtherPort).length,
    external: new Set(ports.filter((p) => p.kind === "external").map((p) => p.pid)).size,
    system: ports.filter((p) => p.kind === "system" || p.kind === "portly").length,
  };
}

function groupSummary(group: ActivePortGroup) {
  const c = portCounts(group.ports);
  const parts: string[] = [];
  if (c.managed > 0) parts.push(plural(c.managed, "server", "servers"));
  if (c.external > 0) parts.push(`${c.external} external ${c.external === 1 ? "app" : "apps"}`);
  if (c.otherPorts > 0) parts.push(`${c.otherPorts} other ${c.otherPorts === 1 ? "port" : "ports"}`);
  if (c.system > 0) parts.push(`${c.system} system`);
  if (parts.length === 0) parts.push(plural(group.ports.length, "port", "ports"));
  return parts.join(" · ");
}

function modelSummary(groups: ActivePortGroup[]) {
  const ports = groups.flatMap((g) => g.ports);
  if (ports.length === 0) return "No listening TCP ports";
  const c = portCounts(ports);
  const parts = [`${ports.length} listening`, `${c.managed} managed servers`, `${c.external} external ${c.external === 1 ? "app" : "apps"}`];
  if (c.otherPorts > 0) parts.push(`${c.otherPorts} other ${c.otherPorts === 1 ? "port" : "ports"}`);
  parts.push(`${c.system} system`);
  return parts.join(" · ");
}

function filteredGroups(groups: ActivePortGroup[], query: string): ActivePortGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups.flatMap((group) => {
    const matchesGroup = group.name.toLowerCase().includes(needle) || group.detail.toLowerCase().includes(needle);
    const ports = group.ports.filter(
      (p) =>
        matchesGroup ||
        String(p.port).includes(needle) ||
        String(p.pid).includes(needle) ||
        p.displayName.toLowerCase().includes(needle) ||
        p.command.toLowerCase().includes(needle),
    );
    return ports.length ? [{ ...group, ports }] : [];
  });
}

// ---------- path helpers (Windows: case-insensitive, either separator) ----------

const normalizePath = (path: string) => path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

function expandTilde(path: string, home: string | null) {
  if (!home) return path;
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return home.replace(/[\\/]+$/, "") + path.slice(1);
  return path;
}

function isPathInside(directory: string, root: string, home: string | null) {
  const d = normalizePath(directory);
  const r = normalizePath(expandTilde(root, home));
  return d === r || d.startsWith(r + "\\");
}

function abbreviatingWithTilde(path: string, home: string | null) {
  if (!home) return path;
  const h = home.replace(/[\\/]+$/, "");
  if (normalizePath(path) === normalizePath(h)) return "~";
  if (normalizePath(path).startsWith(normalizePath(h) + "\\")) return "~" + path.slice(h.length);
  return path;
}

const lastPathComponent = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

const systemGroup = (): ActivePortGroup => ({
  id: "system",
  name: "System",
  detail: "Protected background services",
  icon: "gearshape.2",
  color: "var(--secondary-label)",
  rank: 10_000,
  ports: [],
});

function applicationName(listener: Listener, home: string | null) {
  const genericCommands = ["node", "bun", "bun.exe", "python", "python3", "ruby", "java", "php"];
  const command = listener.command.toLowerCase();
  const bare = command.replace(/\.exe$/, "");
  const directory = listener.workingDirectory;
  if (
    (genericCommands.includes(command) || genericCommands.includes(bare)) &&
    directory &&
    directory !== "/" &&
    !(home && normalizePath(directory) === normalizePath(home))
  ) {
    return lastPathComponent(directory);
  }
  return listener.command;
}

function makeGroups(listeners: Listener[], status: PortlyStatus | null, home: string | null): ActivePortGroup[] {
  const projects: ProjectStatus[] = status?.projects ?? [];
  const managed: [ProjectStatus, ServerStatus][] = projects.flatMap((project) =>
    project.servers.filter((s) => s.state === "running" || s.state === "unhealthy").map((s) => [project, s] as [ProjectStatus, ServerStatus]),
  );

  // A managed dev server often opens a second, ephemeral listener from the same
  // child process. The runtime PID belongs to the parent shell, so learn the
  // actual listener PID from the configured port first.
  const managedProcesses = new Map<number, [ProjectStatus, ServerStatus]>();
  for (const entry of managed) {
    const configuredPort = entry[1].port;
    if (configuredPort == null) continue;
    for (const l of listeners) if (l.port === configuredPort) managedProcesses.set(l.pid, entry);
  }

  const projectRank = (project: ProjectStatus) => {
    const i = projects.findIndex((p) => p.id === project.id);
    return i >= 0 ? i : projects.length;
  };
  const projectGroup = (project: ProjectStatus): ActivePortGroup => ({
    id: `project:${project.id}`,
    name: project.name,
    detail: abbreviatingWithTilde(project.root, home),
    icon: project.icon,
    color: hexColor(project.color),
    rank: projectRank(project),
    ports: [],
  });
  const base = (l: Listener) => ({
    id: `${l.pid}:${l.port}`,
    port: l.port,
    pid: l.pid,
    command: l.command,
    user: l.user,
    workingDirectory: l.workingDirectory ?? null,
  });

  const result = new Map<string, ActivePortGroup>();
  for (const listener of listeners) {
    const projectByPath = listener.workingDirectory ? projects.find((p) => isPathInside(listener.workingDirectory!, p.root, home)) : undefined;
    const exactManagedHit = managed.find(([, s]) => s.port === listener.port || (s.pid != null && s.pid === listener.pid));
    const managedHit = exactManagedHit ?? managedProcesses.get(listener.pid);

    let port: ActivePort;
    let group: ActivePortGroup;
    if (managedHit) {
      const [project, server] = managedHit;
      const isPrimaryPort = server.port === listener.port;
      port = {
        ...base(listener),
        applicationName: project.name,
        displayName: isPrimaryPort ? server.name : "Auxiliary listener",
        kind: "managed",
        serverID: server.id,
        isPrimaryPort,
      };
      group = projectGroup(project);
    } else if (status && listener.port === status.apiPort) {
      // macOS also checks listener.pid == getpid(); the daemon's PID is not exposed here.
      port = { ...base(listener), applicationName: "Portly", displayName: "Control API", kind: "portly", serverID: null, isPrimaryPort: true };
      group = systemGroup();
    } else if (projectByPath) {
      port = { ...base(listener), applicationName: projectByPath.name, displayName: listener.command, kind: "external", serverID: null, isPrimaryPort: true };
      group = projectGroup(projectByPath);
    } else {
      port = { ...base(listener), applicationName: applicationName(listener, home), displayName: listener.command, kind: "system", serverID: null, isPrimaryPort: true };
      group = systemGroup();
    }

    const populated = result.get(group.id) ?? group;
    if (!populated.ports.some((p) => p.id === port.id)) populated.ports.push(port);
    result.set(group.id, populated);
  }

  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  return [...result.values()]
    .map((group) => {
      const ports = group.ports.map((p) => ({ ...p }));
      const byPid = new Map<number, ActivePort[]>();
      for (const p of ports) if (p.kind === "external") byPid.set(p.pid, [...(byPid.get(p.pid) ?? []), p]);
      for (const same of byPid.values()) {
        if (same.length < 2) continue;
        const primary = same.reduce((a, b) => (b.port < a.port ? b : a));
        for (const p of same) p.isPrimaryPort = p === primary;
      }
      ports.sort((l, r) => (l.isPrimaryPort !== r.isPrimaryPort ? (l.isPrimaryPort ? -1 : 1) : l.port - r.port));
      return { ...group, ports };
    })
    .sort((l, r) => (l.rank === r.rank ? collator.compare(l.name, r.name) : l.rank - r.rank));
}

// ---------- view ----------

export default function PortsView() {
  const { status } = usePortly();
  const statusRef = useRef(status);
  statusRef.current = status;
  const [home, setHome] = useState<string | null>(null);
  const homeRef = useRef(home);
  homeRef.current = home;

  const [listeners, setListeners] = useState<Listener[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pendingTermination, setPendingTermination] = useState<ActivePort | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    homeDir().then(setHome, () => {});
  }, []);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setIsLoading(true);
    try {
      const list = await api.listeners();
      if (current !== generation.current) return;
      setListeners(list);
      setError(null);
    } catch (e) {
      if (current !== generation.current) return;
      setError((e as Error).message || "The listening ports could not be read.");
    }
    setIsLoading(false);
  }, []);

  // .task { while !cancelled { refresh; sleep 4 s } }
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const loop = async () => {
      await refresh();
      if (alive) timer = window.setTimeout(loop, 4000);
    };
    void loop();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  // .onChange(of: supervisor.revision): refresh when any server's state changes.
  const revision = useMemo(
    () =>
      [...(status?.projects.flatMap((p) => p.servers) ?? []), ...(status?.temporaryServers ?? [])]
        .map((s) => `${s.id}:${s.state}:${s.pid ?? ""}:${s.port ?? ""}`)
        .join("|"),
    [status],
  );
  const firstRevision = useRef(true);
  useEffect(() => {
    if (firstRevision.current) {
      firstRevision.current = false;
      return;
    }
    void refresh();
  }, [revision, refresh]);

  const groups = useMemo(() => makeGroups(listeners ?? [], status, home), [listeners, status, home]);
  const visibleGroups = useMemo(() => filteredGroups(groups, search), [groups, search]);
  const revealForSearch = search.trim() !== "";

  const open = (port: ActivePort) => {
    if (!canOpen(port)) return;
    void openExternal(`http://localhost:${port.port}`);
  };

  const stop = async (port: ActivePort) => {
    if (port.kind === "managed") {
      const server = port.serverID ? statusRef.current?.projects.flatMap((p) => p.servers).find((s) => s.id === port.serverID) : undefined;
      if (!server) {
        setActionError(`Portly could not find the managed server for port ${port.port}.`);
        return;
      }
      try {
        await api.stop({ server: server.id });
      } catch (e) {
        setActionError((e as Error).message || "The process could not be stopped.");
        return;
      }
    } else if (port.kind === "external") {
      // PortInspector.stopOccupant(of:expectedPID:) — revalidate, then stop.
      try {
        const { occupant } = await api.port(port.port);
        if (!occupant) {
          setActionError("The port is already free.");
          return;
        }
        if (occupant.pid !== port.pid) {
          setActionError("The listener changed before Portly could stop it. Refresh and try again.");
          return;
        }
        await api.killPort(port.port);
      } catch (e) {
        setActionError((e as Error).message || "The process could not be stopped.");
        return;
      }
    } else {
      return;
    }
    await new Promise((r) => setTimeout(r, 350));
    await refresh();
  };

  const requestStop = (port: ActivePort) => {
    if (port.kind === "managed") void stop(port);
    else if (port.kind === "external") setPendingTermination(port);
  };

  const header = (
    <div className="pv-header">
      <div className="pv-header-icon">
        <Symbol name="network" size={19} strokeWidth={2.1} />
      </div>
      <div className="pv-vstack" style={{ gap: 2, minWidth: 0 }}>
        <div className="pv-title">Active ports</div>
        <div className="pv-summary secondary digits">{modelSummary(groups)}</div>
      </div>
      <div className="pv-spacer" />
      <TextField value={search} onChange={setSearch} placeholder="Search ports" width={190} />
      <Button onClick={() => void refresh()} disabled={isLoading} help="Refresh ports" aria-label="Refresh ports">
        <Symbol name="arrow.clockwise" size={13} />
      </Button>
    </div>
  );

  let content;
  if (isLoading && groups.length === 0 && listeners == null) {
    content = (
      <div className="pv-center">
        <ProgressSpinner size={20} />
        <span className="pv-loading-label secondary">Scanning listening ports…</span>
      </div>
    );
  } else if (error != null && groups.length === 0) {
    content = (
      <div className="pv-center">
        <ContentUnavailable
          symbol="exclamationmark.triangle"
          title="Unable to scan ports"
          description={error}
          actions={<Button onClick={() => void refresh()}>Scan again</Button>}
        />
      </div>
    );
  } else if (groups.length === 0) {
    content = (
      <div className="pv-center">
        <ContentUnavailable symbol="network.slash" title="No active ports" description="No TCP processes are listening on this PC." />
      </div>
    );
  } else if (visibleGroups.length === 0) {
    content = (
      <div className="pv-center">
        <ContentUnavailable symbol="magnifyingglass" title={`No Results for “${search}”`} description="Check the spelling or try a new search." />
      </div>
    );
  } else {
    content = (
      <div className="pv-scroll">
        <div className="pv-list">
          {visibleGroups.map((group) =>
            group.id === "system" ? (
              <SystemPortsCard key={group.id} group={group} revealForSearch={revealForSearch} />
            ) : (
              <PortGroupCard key={group.id} group={group} onOpen={open} onStop={requestStop} />
            ),
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="pv-root">
      {header}
      <Divider />
      {content}

      <Alert
        open={pendingTermination != null}
        title={pendingTermination ? `Terminate ${pendingTermination.applicationName}?` : "Terminate process?"}
        message="Portly revalidates the listener before stopping it. Regular processes are asked to close, and their process tree is ended if they are still running 2 seconds later; if Docker publishes this port, only that container is stopped—not Docker Desktop."
        actions={[
          {
            label: `Terminate ${pendingTermination?.applicationName ?? ""}`,
            role: "destructive",
            onClick: () => {
              const port = pendingTermination;
              setPendingTermination(null);
              if (port) void stop(port);
            },
          },
          { label: "Cancel", role: "cancel", onClick: () => setPendingTermination(null) },
        ]}
      />
      <Alert
        open={actionError != null}
        title="Unable to stop process"
        message={actionError ?? "The process could not be stopped."}
        actions={[{ label: "OK", role: "cancel", onClick: () => setActionError(null) }]}
      />
    </div>
  );
}

// ---------- cards ----------

function SystemPortsCard({ group, revealForSearch }: { group: ActivePortGroup; revealForSearch: boolean }) {
  const [showsPorts, setShowsPorts] = useState(false);
  const isExpanded = showsPorts || revealForSearch;
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  const applications = [...new Set(group.ports.map((p) => p.applicationName))].sort((a, b) => collator.compare(a, b));
  const summary = `${applications.length} ${applications.length === 1 ? "service" : "services"} · ${group.ports.length} ports`;

  return (
    <div className="pv-card pv-card-system">
      <button
        type="button"
        className="pv-card-toggle pv-system-header"
        onClick={() => setShowsPorts((v) => !v)}
        aria-label={isExpanded ? "Hide System ports" : "Show System ports"}
        aria-expanded={isExpanded}
      >
        <span className="pv-system-icon">
          <Symbol name="gearshape.2" size={13} strokeWidth={2.1} />
        </span>
        <span className="pv-vstack" style={{ gap: 2, alignItems: "flex-start" }}>
          <span className="pv-group-name">System</span>
          <span className="pv-small secondary">Protected background services · Read only</span>
        </span>
        <span className="pv-spacer" />
        <span className="pv-small-medium secondary digits">{summary}</span>
        <span className="pv-chevron secondary">
          <Symbol name={isExpanded ? "chevron.down" : "chevron.right"} size={9} strokeWidth={2.8} />
        </span>
      </button>

      {isExpanded &&
        applications.map((application) => {
          const ports = group.ports.filter((p) => p.applicationName === application).sort((a, b) => a.port - b.port);
          return (
            <div key={application}>
              <Divider style={{ marginLeft: 50 }} />
              <div className="pv-system-app">
                <span className="pv-app-icon secondary">
                  <Symbol name="app.dashed" size={11} strokeWidth={2.1} />
                </span>
                <span className="pv-app-name">{application}</span>
                <span className="pv-spacer" />
                <span className="pv-small secondary digits">{plural(ports.length, "port", "ports")}</span>
              </div>
              {ports.map((port, index) => (
                <div key={port.id}>
                  {index > 0 && <Divider style={{ marginLeft: 50 }} />}
                  <SystemPortRow port={port} />
                </div>
              ))}
            </div>
          );
        })}
    </div>
  );
}

function SystemPortRow({ port }: { port: ActivePort }) {
  return (
    <div className="pv-row pv-row-system">
      <span className="pv-port digits">:{port.port}</span>
      <span className="pv-vstack" style={{ gap: 2, minWidth: 0 }}>
        <span className="pv-hstack" style={{ gap: 6 }}>
          <span className="pv-row-name">{port.displayName}</span>
          <span className="pv-badge" style={{ color: "var(--secondary-label)", background: "color-mix(in srgb, var(--secondary-label) 12%, transparent)" }}>
            Protected
          </span>
        </span>
        <MiddleTruncated className="pv-detail secondary selectable" text={processDetail(port)} />
      </span>
      <span className="pv-spacer" />
      <span className="tertiary pv-lock" aria-label="Protected system listener">
        <Symbol name="lock.fill" size={10} strokeWidth={2.1} />
      </span>
    </div>
  );
}

function PortGroupCard({ group, onOpen, onStop }: { group: ActivePortGroup; onOpen: (p: ActivePort) => void; onStop: (p: ActivePort) => void }) {
  const [showsOtherPorts, setShowsOtherPorts] = useState(false);
  const primaryPorts = group.ports.filter((p) => !isOtherPort(p));
  const otherPorts = group.ports.filter(isOtherPort);
  const divider = <Divider style={{ marginLeft: 41 }} />;

  return (
    <div className="pv-card pv-card-group">
      <div className="pv-group-header">
        <span className="pv-group-icon" style={{ color: group.color }}>
          <Symbol name={group.icon} size={13} strokeWidth={2.1} />
        </span>
        <span className="pv-vstack" style={{ gap: 1, minWidth: 0 }}>
          <span className="pv-group-name">{group.name}</span>
          {group.detail !== "" && <MiddleTruncated className="pv-small secondary" text={group.detail} />}
        </span>
        <span className="pv-spacer" />
        <span className="pv-small-medium secondary digits">{groupSummary(group)}</span>
      </div>

      {divider}

      {primaryPorts.map((port, index) => (
        <div key={port.id}>
          <PortRow port={port} onOpen={onOpen} onStop={onStop} />
          {index < primaryPorts.length - 1 && divider}
        </div>
      ))}

      {otherPorts.length > 0 && (
        <>
          {primaryPorts.length > 0 && divider}
          <button type="button" className="pv-card-toggle pv-other-toggle" onClick={() => setShowsOtherPorts((v) => !v)} aria-expanded={showsOtherPorts}>
            <span className="pv-chevron secondary">
              <Symbol name={showsOtherPorts ? "chevron.down" : "chevron.right"} size={9} strokeWidth={2.8} />
            </span>
            <span className="pv-other-label">{`${otherPorts.length} other ${otherPorts.length === 1 ? "port" : "ports"}`}</span>
            <span className="pv-spacer" />
            <span className="pv-small secondary">Same process</span>
          </button>
          {showsOtherPorts && (
            <>
              {divider}
              {otherPorts.map((port, index) => (
                <div key={port.id}>
                  <PortRow port={port} onOpen={onOpen} onStop={onStop} />
                  {index < otherPorts.length - 1 && divider}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

function PortRow({ port, onOpen, onStop }: { port: ActivePort; onOpen: (p: ActivePort) => void; onStop: (p: ActivePort) => void }) {
  const fg = badgeForeground(port);
  return (
    <div className="pv-row">
      <span className="pv-port digits">:{port.port}</span>
      <span className="pv-vstack" style={{ gap: 2, minWidth: 0 }}>
        <span className="pv-hstack" style={{ gap: 6, minWidth: 0 }}>
          <span className="pv-row-name pv-line1">{port.displayName}</span>
          <span className="pv-badge" style={{ color: fg, background: `color-mix(in srgb, ${fg} 12%, transparent)` }}>{badgeLabel(port)}</span>
        </span>
        <MiddleTruncated className="pv-detail secondary selectable" text={processDetail(port)} />
      </span>
      <span className="pv-spacer" style={{ minWidth: 10 }} />
      {canOpen(port) && (
        <Button variant="borderless" onClick={() => onOpen(port)} aria-label={`Open localhost port ${port.port}`} help={`Open localhost:${port.port}`}>
          <Symbol name="safari" size={13} />
        </Button>
      )}
      {canStop(port) && (
        <Button
          variant="borderless"
          onClick={() => onStop(port)}
          aria-label={port.kind === "managed" ? `Stop ${port.displayName}` : `Terminate ${port.applicationName}`}
          help={port.kind === "managed" ? "Stop server" : "Terminate process"}
        >
          <Symbol
            name={port.kind === "managed" ? "stop.fill" : "xmark"}
            size={13}
            style={{ color: port.kind === "external" ? "var(--sys-red)" : "var(--label)" }}
          />
        </Button>
      )}
    </div>
  );
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** `.lineLimit(1).truncationMode(.middle)`. */
function MiddleTruncated({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      measureCtx ??= document.createElement("canvas").getContext("2d");
      const width = el.clientWidth;
      if (!measureCtx || width <= 0) return setShown(text);
      const cs = getComputedStyle(el);
      measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const fits = (s: string) => measureCtx!.measureText(s).width <= width;
      if (fits(text)) return setShown(text);
      const candidate = (keep: number) => {
        const head = Math.ceil(keep / 2);
        return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
      };
      let lo = 0;
      let hi = text.length - 1;
      while (lo < hi) {
        const keep = Math.ceil((lo + hi) / 2);
        if (fits(candidate(keep))) lo = keep;
        else hi = keep - 1;
      }
      setShown(candidate(lo));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <span ref={ref} className={`pv-middle ${className ?? ""}`} title={text}>
      {shown}
    </span>
  );
}
