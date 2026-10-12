// Port of Sources/PortlyApp/ResourceDashboard.swift.
// Swift Charts are drawn with inline SVG (see LineChart / BarChart below) using the
// same marks, axes, gridline opacities and label formats as the SwiftUI view.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Folder, Hourglass, Monitor, type LucideIcon, type LucideProps } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { api, type PortlyStatus, type ProjectStatus, type ResourceSample, type ServerState, type ServerStatus, isActiveState } from "../lib/api";
import { act, usePortly } from "../lib/store";
import { Symbol } from "../lib/symbols";
import { Alert, Button, ContentUnavailable, Divider, ProgressSpinner, StatusDot, T, hexColor, severityColor, severityImage } from "../components/ui";
import {
  advice, analyze, bytes, externalFromApi, fixed, localizedStandardCompare, makeChartStyles, maxSeverity, metricsByServer,
  severityLabel, type DashboardProjectChartStyle, type ExternalProcess, type ManagedProcess, type MemoryDiagnostic,
  type ProcessMetrics, type ProjectResourceHistoryPoint, type ResourceHistoryPoint,
} from "../lib/memoryDiagnostics";
import "./ResourceDashboard.css";

// ---------- symbols missing from the shared table ----------

const extraSymbols: Record<string, LucideIcon> = { desktopcomputer: Monitor, hourglass: Hourglass, folder: Folder };
function Sym({ name, size = 13, ...rest }: { name: string; size?: number } & Omit<LucideProps, "size">) {
  const E = extraSymbols[name];
  if (E) return <E size={Math.round(size * 1.05)} strokeWidth={size <= 10 ? 2.6 : 2} aria-hidden {...rest} />;
  return <Symbol name={name} size={size} {...rest} />;
}

// ---------- Supervisor-side history (Supervisor.recordResourceHistory) ----------
// Module scope so the five-minute window survives navigating away and back,
// like Supervisor.shared keeps it while the dashboard is not on screen.

let resourceHistory: ResourceHistoryPoint[] = [];
let projectResourceHistory: ProjectResourceHistoryPoint[] = [];
let lastSample: ResourceSample | null = null;
let pointID = 0;

interface ServerLookup { server: ServerStatus; project: ProjectStatus | null }

function lookupServers(status: PortlyStatus | null): Map<string, ServerLookup> {
  const map = new Map<string, ServerLookup>();
  for (const project of status?.projects ?? []) for (const server of project.servers) map.set(server.id, { server, project });
  for (const server of status?.temporaryServers ?? []) map.set(server.id, { server, project: status?.projects.find((p) => p.id === server.projectID) ?? null });
  return map;
}

function recordResourceHistory(sample: ResourceSample, status: PortlyStatus | null) {
  const now = Date.now();
  const managed = sample.managed;
  resourceHistory.push({
    id: ++pointID,
    timestamp: now,
    footprintBytes: managed.reduce((s, m) => s + m.footprintBytes, 0),
    residentBytes: managed.reduce((s, m) => s + m.residentBytes, 0),
    cpuPercent: managed.reduce((s, m) => s + m.cpuPercent, 0),
    processCount: managed.reduce((s, m) => s + Math.max(1, m.processCount || 1), 0),
  });
  // Five minutes at the two-second sampling interval.
  if (resourceHistory.length > 150) resourceHistory = resourceHistory.slice(resourceHistory.length - 150);

  const lookup = lookupServers(status);
  const totals = new Map<string, { name: string; colorHex: string; footprintBytes: number; residentBytes: number }>();
  for (const m of managed) {
    const hit = lookup.get(m.serverID);
    if (!hit) continue;
    const projectID = hit.server.projectID;
    const total = totals.get(projectID) ?? {
      name: hit.project?.name ?? hit.server.projectName,
      colorHex: hit.project?.color ?? "8E8E93",
      footprintBytes: 0,
      residentBytes: 0,
    };
    total.footprintBytes += m.footprintBytes;
    total.residentBytes += m.residentBytes;
    totals.set(projectID, total);
  }
  for (const [projectID, t] of totals) {
    projectResourceHistory.push({ id: ++pointID, timestamp: now, projectID, projectName: t.name, colorHex: t.colorHex, footprintBytes: t.footprintBytes, residentBytes: t.residentBytes });
  }
  const cutoff = now - 300_000;
  projectResourceHistory = projectResourceHistory.filter((p) => p.timestamp >= cutoff);
}

// ---------- rows ----------

interface DashboardServerRow {
  id: string;
  projectID: string;
  projectName: string;
  projectColorHex: string;
  name: string;
  state: ServerState;
  metrics: ProcessMetrics;
  fullName: string;
}

interface DashboardProjectRow {
  id: string;
  name: string;
  colorHex: string;
  footprintBytes: number;
  residentBytes: number;
  cpuPercent: number;
  processCount: number;
  serverCount: number;
}

interface DashboardProcessRow { id: string; serverName: string; serverState: ServerState; process: ManagedProcess }

const gibibytes = (v: number) => v / 1_073_741_824;
const percent = (v: number) => `${fixed(v * 100, 1)}%`;
const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export default function ResourceDashboard() {
  const { status } = usePortly();
  const statusRef = useRef(status);
  statusRef.current = status;
  const [sample, setSample] = useState<ResourceSample | null>(lastSample);
  const [pendingExternalStop, setPendingExternalStop] = useState<ExternalProcess | null>(null);
  const [processActionError, setProcessActionError] = useState<string | null>(null);
  const [stoppingProcessIDs, setStoppingProcessIDs] = useState<Set<number>>(new Set());

  // Supervisor.startMetricsTimer: one sample every two seconds, never overlapping.
  useEffect(() => {
    let alive = true;
    let inflight = false;
    const tick = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const s = await api.resources();
        if (!alive) return;
        recordResourceHistory(s, statusRef.current);
        lastSample = s;
        setSample(s);
      } catch {
        /* daemon unreachable: keep the last sample */
      } finally {
        inflight = false;
      }
    };
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const lookup = useMemo(() => lookupServers(status), [status]);

  const serverRows = useMemo<DashboardServerRow[]>(() => {
    if (!sample) return [];
    const metrics = metricsByServer(sample.managed, (id) => lookup.get(id)?.server.command ?? "");
    const rows: DashboardServerRow[] = [];
    for (const [id, m] of metrics) {
      const hit = lookup.get(id);
      if (!hit) continue;
      const projectName = hit.project?.name ?? hit.server.projectName;
      rows.push({
        id,
        projectID: hit.server.projectID,
        projectName,
        projectColorHex: hit.project?.color ?? "8E8E93",
        name: hit.server.name,
        state: hit.server.state,
        metrics: m,
        fullName: `${projectName} / ${hit.server.name}`,
      });
    }
    return rows.sort((a, b) =>
      a.metrics.memoryBytes !== b.metrics.memoryBytes ? b.metrics.memoryBytes - a.metrics.memoryBytes : localizedStandardCompare(a.fullName, b.fullName),
    );
  }, [sample, lookup]);

  const projectRows = useMemo<DashboardProjectRow[]>(() => {
    const groups = new Map<string, DashboardServerRow[]>();
    for (const s of serverRows) groups.set(s.projectID, [...(groups.get(s.projectID) ?? []), s]);
    const rows: DashboardProjectRow[] = [];
    for (const [projectID, servers] of groups) {
      const first = servers[0];
      rows.push({
        id: projectID,
        name: first.projectName,
        colorHex: first.projectColorHex,
        footprintBytes: servers.reduce((s, r) => s + r.metrics.memoryBytes, 0),
        residentBytes: servers.reduce((s, r) => s + r.metrics.residentMemoryBytes, 0),
        cpuPercent: servers.reduce((s, r) => s + r.metrics.cpuPercent, 0),
        processCount: servers.reduce((s, r) => s + r.metrics.processCount, 0),
        serverCount: servers.length,
      });
    }
    return rows.sort((a, b) => (a.footprintBytes !== b.footprintBytes ? b.footprintBytes - a.footprintBytes : localizedStandardCompare(a.name, b.name)));
  }, [serverRows]);

  const processRows = useMemo<DashboardProcessRow[]>(
    () =>
      serverRows
        .flatMap((server) => server.metrics.processes.map((process) => ({ id: `${server.id}-${process.pid}`, serverName: server.fullName, serverState: server.state, process })))
        .sort((a, b) => (a.process.memoryBytes !== b.process.memoryBytes ? b.process.memoryBytes - a.process.memoryBytes : a.process.pid - b.process.pid)),
    [serverRows],
  );

  const totalFootprint = serverRows.reduce((s, r) => s + r.metrics.memoryBytes, 0);
  const totalResident = serverRows.reduce((s, r) => s + r.metrics.residentMemoryBytes, 0);
  const totalCPU = serverRows.reduce((s, r) => s + r.metrics.cpuPercent, 0);
  // processRows.count on macOS; the daemon may aggregate a server's tree into one row.
  const totalProcesses = serverRows.reduce((s, r) => s + r.metrics.processCount, 0);
  const physicalMemoryBytes = sample?.totalMemoryBytes ?? 0;
  const externalProcesses = useMemo(() => externalFromApi(sample?.external ?? []).slice(0, 20), [sample]);

  const diagnostics = useMemo(
    () =>
      analyze({
        servers: serverRows.map((r) => ({ id: r.id, projectID: r.projectID, fullName: r.fullName, metrics: r.metrics })),
        projectHistory: projectResourceHistory,
        externalProcesses,
        physicalMemoryBytes,
      }),
    // projectResourceHistory changes with every sample.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverRows, externalProcesses, physicalMemoryBytes, sample],
  );

  const managedResidentPercent = physicalMemoryBytes > 0 ? percent(totalResident / physicalMemoryBytes) : "—";

  const runtimeFor = (serverID: string) => lookup.get(serverID)?.server ?? null;

  const externalProcessFor = (d: MemoryDiagnostic) => {
    if (d.serverID != null || d.processID == null) return null;
    return externalProcesses.find((p) => p.pid === d.processID) ?? null;
  };

  const migrationRuntime = (process: ExternalProcess): ServerStatus | null => {
    const servers = [...lookup.values()].map((l) => l.server);
    for (const port of process.listeningPorts) {
      const runtime = servers.find((s) => s.port === port && !isActiveState(s.state));
      if (runtime) return runtime;
    }
    return null;
  };

  const externalStopTitle = !pendingExternalStop
    ? "Stop process?"
    : pendingExternalStop.terminationPID === pendingExternalStop.pid
      ? `Stop ${pendingExternalStop.displayName}?`
      : "Stop parent dev session?";

  const externalStopMessage = (p: ExternalProcess) => {
    const scope = p.terminationPID === p.pid ? `PID ${p.pid}` : `PID ${p.terminationPID} and its child processes`;
    return `Portly will revalidate the command, then ask ${scope} to close and end the process tree if it is still running 2 seconds later. Target: ${p.terminationCommand}`;
  };

  const stopExternalProcess = async (p: ExternalProcess) => {
    setPendingExternalStop(null);
    setStoppingProcessIDs((s) => new Set(s).add(p.terminationPID));
    try {
      await api.stopProcess(p.pid, p.startTime);
    } catch (e) {
      setProcessActionError((e as Error).message || "The process could not be stopped.");
    }
    await new Promise((r) => setTimeout(r, 1000));
    setStoppingProcessIDs((s) => {
      const next = new Set(s);
      next.delete(p.terminationPID);
      return next;
    });
  };

  // ---------- sections ----------

  const header = (
    <div className="rd-header">
      <div className="rd-header-text">
        <div className="rd-page-title selectable">Resource dashboard</div>
        <div style={T.body} className="secondary">Live process monitoring with machine-aware memory diagnostics and safe fixes.</div>
      </div>
      <div className="rd-spacer" />
      <div className="rd-live" style={T.bodyMedium} aria-label="Live data, updated every 2 seconds">
        <Symbol name="dot.radiowaves.left.and.right" size={13} style={{ color: "var(--sys-green)" }} />
        <span>Live · 2 s</span>
      </div>
    </div>
  );

  const overviewCard = (title: string, value: string, detail: string, systemImage: string, color: string) => (
    <div className="rd-overview-card rd-material" aria-label={`${title}, ${value}, ${detail}`} key={title}>
      <div className="rd-hstack" style={{ gap: 10 }}>
        <span className="rd-icon-box" style={{ width: 34, height: 34, color, background: tint(color, 12) }}>
          <Sym name={systemImage} size={14} strokeWidth={2.4} />
        </span>
        <span style={T.bodyMedium}>{title}</span>
      </div>
      <div className="rd-overview-value digits">{value}</div>
      <div className="rd-overview-detail secondary" style={T.metadata}>{detail}</div>
    </div>
  );

  const overview = (
    <div className="rd-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
      {overviewCard("Managed footprint", bytes(totalFootprint), "Owned, compressed, or swapped", "memorychip", "var(--sys-orange)")}
      {overviewCard("Managed resident", bytes(totalResident), "Currently in RAM", "memorychip.fill", "var(--sys-blue)")}
      {overviewCard("CPU", `${fixed(totalCPU, 1)}%`, "Across all cores", "cpu", "var(--sys-purple)")}
      {overviewCard("Processes", String(totalProcesses), `Managed across ${serverRows.length} active servers`, "square.stack.3d.up", "var(--sys-cyan)")}
      {overviewCard("Machine memory", bytes(physicalMemoryBytes), `Managed services currently resident: ${managedResidentPercent}`, "desktopcomputer", "var(--sys-green)")}
    </div>
  );

  const externalProcessDetails = (process: ExternalProcess) => (
    <div className="rd-external-details">
      <div className="rd-hstack" style={{ gap: 8, ...T.metadata }}>
        <Label icon="arrow.up.right.square" iconSize={10.5}>Outside Portly</Label>
        <div className="rd-spacer" />
        <span className="digits">Footprint {bytes(process.memoryBytes)} · RAM {bytes(process.residentMemoryBytes)}</span>
      </div>
      <div className="rd-clamp2 secondary selectable" style={T.metadata} title={process.command}>{process.command}</div>
      {process.terminationPID !== process.pid ? (
        <div className="rd-clamp2 secondary selectable" style={T.metadata} title={process.terminationCommand}>
          Stop target: PID {process.terminationPID} · {process.terminationCommand}
        </div>
      ) : process.parentCommand != null ? (
        <div className="rd-line1 secondary selectable" style={T.metadata} title={process.parentCommand}>
          Parent PID {process.parentPID} · {process.parentCommand}
        </div>
      ) : null}
      <div className="rd-hstack secondary" style={{ gap: 12, ...T.metadata, minWidth: 0 }}>
        {process.workingDirectory != null && (
          <Label icon="folder" iconSize={10.5} className="rd-line1-label" title={process.workingDirectory}>{process.workingDirectory}</Label>
        )}
        {process.listeningPorts.length > 0 ? (
          <Label icon="network" iconSize={10.5}>{process.listeningPorts.map((p) => `:${p}`).join(", ")}</Label>
        ) : (
          <Label icon="network.slash" iconSize={10.5}>No listening port · cannot be moved as a server</Label>
        )}
      </div>
      <div className="tertiary" style={T.metadata}>
        Footprint is memory still owned, including compressed or swapped pages. RAM is what is resident right now.
      </div>
    </div>
  );

  const diagnosticCard = (d: MemoryDiagnostic) => {
    const color = severityColor(d.severity);
    const externalProcess = externalProcessFor(d);
    const runtime = d.serverID != null ? runtimeFor(d.serverID) : null;
    const stopping = externalProcess ? stoppingProcessIDs.has(externalProcess.terminationPID) : false;
    const migration = externalProcess ? migrationRuntime(externalProcess) : null;
    return (
      <div key={d.id} className="rd-diagnostic" style={{ background: tint(color, 4.5), boxShadow: `inset 0 0 0 0.75px ${tint(color, 20)}` }}>
        <div className="rd-hstack" style={{ gap: 10, alignItems: "flex-start" }}>
          <span className="rd-icon-box" style={{ width: 32, height: 32, color, background: tint(color, 12) }} aria-hidden>
            <Symbol name={severityImage(d.severity)} size={15} strokeWidth={2.4} />
          </span>
          <div className="rd-vstack" style={{ gap: 3, minWidth: 0 }}>
            <div style={T.bodyMedium} className="selectable">{d.title}</div>
            <div style={T.metadata} className="secondary selectable">{d.summary}</div>
          </div>
          <div className="rd-spacer" style={{ minWidth: 8 }} />
          <span className="rd-severity-badge" style={{ ...T.label, color, background: tint(color, 10) }}>{severityLabel(d.severity).toUpperCase()}</span>
        </div>

        <Label icon="wrench.and.screwdriver" style={T.body} className="selectable rd-fix" alignTop>{d.fix}</Label>

        {externalProcess && externalProcessDetails(externalProcess)}

        {(d.serverID != null || d.processID != null) && (
          <>
            <Divider />
            <div className="rd-hstack" style={{ gap: 8 }}>
              {d.serverID != null && runtime ? (
                <>
                  <Button variant="prominent" onClick={() => void act(() => api.restart({ server: runtime.id }))}>Restart server</Button>
                  <Button onClick={() => void act(() => api.stop({ server: runtime.id }))}>Stop server</Button>
                </>
              ) : externalProcess ? (
                <>
                  <Button
                    variant="prominent"
                    style={{ background: "var(--sys-red)", color: "#fff" }}
                    disabled={stopping}
                    onClick={() => setPendingExternalStop(externalProcess)}
                  >
                    {stopping ? (
                      <><Sym name="hourglass" size={12} />Stopping…</>
                    ) : (
                      <><Symbol name="stop.fill" size={11} />{externalProcess.terminationPID === externalProcess.pid ? "Stop process" : "Stop dev session"}</>
                    )}
                  </Button>
                  {migration && (
                    <Button
                      help={`Move port ${migration.port != null ? String(migration.port) : ""} to ${migration.projectName} / ${migration.name}`}
                      onClick={() => void act(() => api.takeOver(migration.id))}
                    >
                      Move to Portly
                    </Button>
                  )}
                  <Button onClick={openTaskManager}>
                    <Symbol name="arrow.up.forward.app" size={12} />Open Task Manager
                  </Button>
                </>
              ) : null}
              {d.processID != null && (
                <>
                  <div className="rd-spacer" />
                  <span className="secondary digits" style={T.metadata}>PID {d.processID}</span>
                </>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  const smartRecommendations = (() => {
    const highest = maxSeverity(diagnostics.map((d) => d.severity));
    return (
      <DashboardSection
        title="Smart recommendations"
        subtitle={`${severityLabel(highest)} · thresholds adapt to this PC and trends ignore one-off build spikes`}
      >
        <div className="rd-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", alignItems: "start" }}>
          {diagnostics.map(diagnosticCard)}
        </div>
      </DashboardSection>
    );
  })();

  const collecting = (text: string, minHeight: number) => (
    <div className="rd-collecting" style={{ minHeight }}>
      <ProgressSpinner size={16} />
      <span style={T.body} className="secondary">{text}</span>
    </div>
  );

  const axisGB = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 1 })} GB`;

  const memoryHistory = (
    <DashboardSection title="Managed memory history" subtitle="All managed projects · five-minute window">
      {resourceHistory.length < 2 ? (
        collecting("Collecting history…", 240)
      ) : (
        <div className="rd-vstack" style={{ gap: 14 }}>
          <div className="rd-hstack" style={{ gap: 18 }}>
            <Legend title="Footprint" color="var(--sys-orange)" />
            <Legend title="Resident" color="var(--sys-blue)" />
          </div>
          <LineChart
            ariaLabel={`Memory history. Current footprint ${bytes(totalFootprint)}; resident ${bytes(totalResident)}`}
            yFormat={axisGB}
            series={[
              { id: "Footprint", color: "var(--sys-orange)", dash: [], area: true, points: resourceHistory.map((p) => ({ t: p.timestamp, v: gibibytes(p.footprintBytes) })) },
              { id: "Resident", color: "var(--sys-blue)", dash: [], points: resourceHistory.map((p) => ({ t: p.timestamp, v: gibibytes(p.residentBytes) })) },
            ]}
          />
        </div>
      )}
    </DashboardSection>
  );

  const projectHistory = (() => {
    const history = projectResourceHistory;
    const styles = makeChartStyles(history, projectRows.map((p) => ({ id: p.id, name: p.name, colorHex: p.colorHex })));
    const footprints = new Map<string, number>();
    for (const p of projectRows) if (!footprints.has(p.id)) footprints.set(p.id, p.footprintBytes);
    const legendOrder = styles
      .map((style) => ({ style, footprintBytes: footprints.get(style.id) }))
      .sort((l, r) => {
        const a = l.footprintBytes;
        const b = r.footprintBytes;
        if (a != null && b != null && a !== b) return b - a;
        if (a == null && b != null) return 1;
        if (a != null && b == null) return -1;
        return localizedStandardCompare(l.style.name, r.style.name);
      });
    return (
      <DashboardSection title="Project history" subtitle="Spot the project whose footprint keeps climbing">
        {history.length < Math.max(2, projectRows.length * 2) ? (
          collecting("Collecting project history…", 220)
        ) : (
          <div className="rd-vstack" style={{ gap: 14 }}>
            <div className="rd-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", rowGap: 8, columnGap: 8 }}>
              {legendOrder.map((entry) => (
                <SeriesLegend
                  key={entry.style.id}
                  title={entry.style.name}
                  detail={entry.footprintBytes != null ? bytes(entry.footprintBytes) : null}
                  color={hexColor(entry.style.colorHex)}
                  dash={entry.style.dash}
                />
              ))}
            </div>
            <LineChart
              ariaLabel={`Memory footprint history by project. ${styles.length} projects in recent history`}
              yFormat={axisGB}
              series={styles.map((style: DashboardProjectChartStyle) => ({
                id: style.id,
                color: hexColor(style.colorHex),
                dash: style.dash,
                points: history.filter((p) => p.projectID === style.id).sort((a, b) => a.timestamp - b.timestamp).map((p) => ({ t: p.timestamp, v: gibibytes(p.footprintBytes) })),
              }))}
            />
          </div>
        )}
      </DashboardSection>
    );
  })();

  const projectImpact = (
    <DashboardSection title="Project impact" subtitle="Every server aggregated by project · highest footprint first">
      <div className="rd-vstack" style={{ gap: 14 }}>
        <BarChart
          ariaLabel="Memory footprint by project"
          xFormat={axisGB}
          height={Math.max(190, projectRows.length * 42)}
          rows={projectRows.map((p) => ({ id: p.id, name: p.name, color: hexColor(p.colorHex), value: gibibytes(p.footprintBytes), annotation: bytes(p.footprintBytes) }))}
        />
      </div>
    </DashboardSection>
  );

  const processes = (
    <DashboardSection title="Managed processes" subtitle="Every managed descendant · sorted by footprint">
      <DataTable
        ariaLabel="Managed processes"
        height={440}
        rows={processRows}
        rowKey={(r) => r.id}
        columns={[
          {
            title: "Process", min: 190, ideal: 300,
            render: (r) => (
              <div className="rd-vstack" style={{ gap: 2, minWidth: 0 }}>
                <div className="rd-line1" style={T.bodyMedium}>{r.process.displayName}</div>
                <div className="rd-line1 secondary" style={T.metadata} title={r.process.command}>{r.process.command}</div>
              </div>
            ),
          },
          {
            title: "Server", min: 150, ideal: 220,
            render: (r) => (
              <div className="rd-hstack" style={{ gap: 7, minWidth: 0, ...T.body }}>
                <StatusDot state={r.serverState} size={7} />
                <span className="rd-line1" title={r.serverName}>{r.serverName}</span>
              </div>
            ),
          },
          { title: "PID", min: 54, ideal: 64, render: (r) => <span className="digits">{r.process.pid}</span> },
          { title: "CPU", min: 64, ideal: 76, render: (r) => <span className="digits">{fixed(r.process.cpuPercent, 1)}%</span> },
          { title: "Footprint", min: 86, ideal: 100, render: (r) => <span className="digits">{bytes(r.process.memoryBytes)}</span> },
          { title: "Resident", min: 86, ideal: 100, render: (r) => <span className="digits">{bytes(r.process.residentMemoryBytes)}</span> },
        ]}
      />
    </DashboardSection>
  );

  const outsidePortlyProcesses = (
    <DashboardSection title="Top processes outside Portly" subtitle="Current user only · top 20 by resident RAM · never stopped automatically">
      <DataTable
        ariaLabel="Processes outside Portly"
        height={420}
        rows={externalProcesses}
        rowKey={(p) => String(p.pid)}
        columns={[
          {
            title: "Process", min: 210, ideal: 320,
            render: (p) => (
              <div className="rd-vstack" style={{ gap: 2, minWidth: 0 }}>
                <div className="rd-line1" style={T.bodyMedium}>{p.displayName}</div>
                <div className="rd-line1 secondary" style={T.metadata} title={p.command}>{p.command}</div>
              </div>
            ),
          },
          { title: "PID", min: 54, ideal: 64, render: (p) => <span className="digits">{p.pid}</span> },
          { title: "CPU", min: 64, ideal: 76, render: (p) => <span className="digits">{fixed(p.cpuPercent, 1)}%</span> },
          { title: "Footprint", min: 86, ideal: 100, render: (p) => <span className="digits">{bytes(p.memoryBytes)}</span> },
          { title: "Resident", min: 86, ideal: 100, render: (p) => <span className="digits">{bytes(p.residentMemoryBytes)}</span> },
          {
            title: "Likely fix", min: 240, ideal: 360,
            render: (p) => {
              const text = advice(p.command, false);
              return <div className="rd-clamp2 secondary" style={T.metadata} title={text}>{text}</div>;
            },
          },
        ]}
      />
    </DashboardSection>
  );

  return (
    <div className="rd-scroll">
      <div className="rd-content">
        {header}
        {serverRows.length === 0 && externalProcesses.length === 0 ? (
          <div className="rd-empty rd-material">
            <ContentUnavailable symbol="chart.xyaxis.line" title="No active processes" description="Start a server to collect live resource data." />
          </div>
        ) : (
          <>
            {overview}
            {smartRecommendations}
            {serverRows.length > 0 && (
              <>
                <div className="rd-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))", alignItems: "start" }}>
                  {memoryHistory}
                  {projectHistory}
                </div>
                {projectImpact}
                {processes}
              </>
            )}
            {externalProcesses.length > 0 && outsidePortlyProcesses}
          </>
        )}
      </div>

      <Alert
        open={pendingExternalStop != null}
        title={externalStopTitle}
        message={pendingExternalStop ? externalStopMessage(pendingExternalStop) : undefined}
        actions={[
          { label: "End Process Tree", role: "destructive", onClick: () => pendingExternalStop && void stopExternalProcess(pendingExternalStop) },
          { label: "Cancel", role: "cancel", onClick: () => setPendingExternalStop(null) },
        ]}
      />
      <Alert
        open={processActionError != null}
        title="Unable to stop process"
        message={processActionError ?? "The process could not be stopped."}
        actions={[{ label: "OK", role: "cancel", onClick: () => setProcessActionError(null) }]}
      />
    </div>
  );
}

/** "Open Activity Monitor" → Task Manager on Windows. */
function openTaskManager() {
  void openPath("C:\\Windows\\System32\\Taskmgr.exe").catch(() => {});
}

// ---------- building blocks ----------

function DashboardSection({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="rd-section rd-material">
      <div className="rd-vstack" style={{ gap: 3 }}>
        <div style={T.title}>{title}</div>
        <div style={T.metadata} className="secondary">{subtitle}</div>
      </div>
      {children}
    </section>
  );
}

/** SwiftUI Label: icon + title. */
function Label({ icon, iconSize, children, style, className = "", title, alignTop }: {
  icon: string; iconSize?: number; children: ReactNode; style?: CSSProperties; className?: string; title?: string; alignTop?: boolean;
}) {
  const size = iconSize ?? (typeof style?.fontSize === "number" ? style.fontSize : 13);
  return (
    <span className={`rd-label ${className}`} style={{ alignItems: alignTop ? "flex-start" : "center", ...style }} title={title}>
      <span className="rd-label-icon" style={alignTop ? { height: "1.25em" } : undefined}><Sym name={icon} size={size} /></span>
      <span className="rd-label-title">{children}</span>
    </span>
  );
}

function Legend({ title, color }: { title: string; color: string }) {
  return (
    <div className="rd-hstack" style={{ gap: 7 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flex: "none" }} aria-hidden />
      <span style={T.bodyMedium}>{title}</span>
    </div>
  );
}

/** Legend entry for a multi-series chart: the swatch repeats the line's dash. */
function SeriesLegend({ title, detail, color, dash }: { title: string; detail: string | null; color: string; dash: number[] }) {
  return (
    <div className="rd-hstack" style={{ gap: 7, minWidth: 0 }} aria-label={detail ? `${title}, ${detail}` : title}>
      <svg width={18} height={2} style={{ overflow: "visible", flex: "none" }} aria-hidden>
        <line x1={0} y1={1} x2={18} y2={1} style={{ stroke: color }} strokeWidth={2} strokeLinecap="round" strokeDasharray={dash.length ? dash.join(" ") : undefined} />
      </svg>
      <span className="rd-line1" style={T.bodyMedium}>{title}</span>
      {detail != null && <span className="secondary digits" style={{ ...T.metadata, flex: "none" }}>{detail}</span>}
    </div>
  );
}

// ---------- Table (SwiftUI Table, inset style with alternating rows) ----------

interface Column<R> { title: string; min: number; ideal: number; render: (row: R) => ReactNode }

function DataTable<R>({ columns, rows, rowKey, height, ariaLabel }: {
  columns: Column<R>[]; rows: R[]; rowKey: (r: R) => string; height: number; ariaLabel: string;
}) {
  const template = columns.map((c) => `minmax(${c.min}px, ${c.ideal}fr)`).join(" ");
  const minWidth = columns.reduce((s, c) => s + c.min, 0);
  return (
    <div className="rd-table" style={{ height }} role="table" aria-label={ariaLabel}>
      <div style={{ minWidth }}>
        <div className="rd-table-header" style={{ gridTemplateColumns: template }} role="row">
          {columns.map((c) => <div key={c.title} className="rd-table-hcell" role="columnheader">{c.title}</div>)}
        </div>
        <div className="rd-table-body">
          {rows.map((r, i) => (
            <div key={rowKey(r)} className={`rd-table-row${i % 2 === 1 ? " alt" : ""}`} style={{ gridTemplateColumns: template, ...T.body }} role="row">
              {columns.map((c) => <div key={c.title} className="rd-table-cell" role="cell">{c.render(r)}</div>)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Charts ----------

const AXIS_FONT = '400 10px Inter, "Segoe UI", sans-serif';
const META_FONT = '400 10.5px "Cascadia Mono", "Cascadia Code", Consolas, monospace';
let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string) {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 6;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Swift Charts' automatic numeric ticks: zero-based, 1/2/5 steps, ~5 values. */
function numericTicks(max: number, desired = 5): number[] {
  const top = max > 0 ? max : 1;
  const raw = top / desired;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  const count = Math.max(1, Math.ceil(top / step - 1e-9));
  return Array.from({ length: count + 1 }, (_, i) => +(i * step).toFixed(10));
}

/** AxisMarks(values: .automatic(desiredCount: 5)) on a date axis. */
function timeTicks(t0: number, t1: number, desired = 5): number[] {
  const span = (t1 - t0) / 1000;
  const steps = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = (steps.find((s) => span / s <= desired) ?? 3600) * 1000;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  return ticks;
}

const minuteSecond = (t: number) => {
  const d = new Date(t);
  return `${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

interface LineSeries { id: string; color: string; dash: number[]; area?: boolean; points: { t: number; v: number }[] }

function LineChart({ series, yFormat, ariaLabel, height = 220 }: { series: LineSeries[]; yFormat: (v: number) => string; ariaLabel: string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const uid = useId().replace(/:/g, "");
  const all = series.flatMap((s) => s.points);
  const W = width;
  const H = height;

  let body: ReactNode = null;
  if (W > 0 && all.length > 0) {
    const t0 = Math.min(...all.map((p) => p.t));
    let t1 = Math.max(...all.map((p) => p.t));
    if (t1 <= t0) t1 = t0 + 1000;
    const yTicks = numericTicks(Math.max(...all.map((p) => p.v)));
    const yMax = yTicks[yTicks.length - 1] || 1;
    const yLabels = yTicks.map(yFormat);
    const labelW = Math.max(...yLabels.map((l) => textWidth(l, AXIS_FONT)));
    const left = Math.ceil(labelW) + 6;
    const top = 6;
    const bottom = H - 18;
    const plotW = Math.max(1, W - left);
    const x = (t: number) => left + ((t - t0) / (t1 - t0)) * plotW;
    const y = (v: number) => bottom - (v / yMax) * (bottom - top);
    const xTicks = timeTicks(t0, t1);

    body = (
      <svg width={W} height={H} style={{ display: "block", overflow: "visible" }} role="img" aria-label={ariaLabel}>
        <defs>
          {series.map((s, i) =>
            s.area ? (
              <linearGradient key={s.id} id={`${uid}-a${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style={{ stopColor: s.color, stopOpacity: 0.24 }} />
                <stop offset="1" style={{ stopColor: s.color, stopOpacity: 0.015 }} />
              </linearGradient>
            ) : null,
          )}
        </defs>
        {xTicks.map((t) => (
          <line key={`xg${t}`} x1={Math.round(x(t)) + 0.5} x2={Math.round(x(t)) + 0.5} y1={top} y2={bottom} className="rd-grid-05" />
        ))}
        {yTicks.map((v) => (
          <line key={`yg${v}`} x1={left} x2={W} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} className="rd-grid-07" />
        ))}
        {yTicks.map((v, i) => (
          <text key={`yl${v}`} x={left - 6} y={y(v)} textAnchor="end" dominantBaseline="central" className="rd-axis-label">{yLabels[i]}</text>
        ))}
        {xTicks.map((t) => {
          const label = minuteSecond(t);
          const lx = x(t) + 2;
          if (lx + textWidth(label, AXIS_FONT) > W + 1) return null;
          return <text key={`xl${t}`} x={lx} y={bottom + 13} className="rd-axis-label">{label}</text>;
        })}
        {series.map((s, i) => {
          if (!s.area || s.points.length === 0) return null;
          const pts = s.points.map((p) => `${x(p.t).toFixed(2)},${y(p.v).toFixed(2)}`);
          const d = `M${x(s.points[0].t).toFixed(2)},${bottom} L${pts.join(" L")} L${x(s.points[s.points.length - 1].t).toFixed(2)},${bottom} Z`;
          return <path key={`a${s.id}`} d={d} style={{ fill: `url(#${uid}-a${i})` }} />;
        })}
        {series.map((s) =>
          s.points.length === 0 ? null : (
            <path
              key={`l${s.id}`}
              d={`M${s.points.map((p) => `${x(p.t).toFixed(2)},${y(p.v).toFixed(2)}`).join(" L")}`}
              style={{ fill: "none", stroke: s.color }}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={s.dash.length ? s.dash.join(" ") : undefined}
            />
          ),
        )}
      </svg>
    );
  }
  return <div ref={ref} style={{ width: "100%", minHeight: H }}>{body}</div>;
}

/** Color(hex:).gradient — the color, slightly lighter at the top. */
function lighten(hex: string, amount: number) {
  const v = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  return `rgb(${c.map((x) => Math.round(x + (255 - x) * amount)).join(",")})`;
}

interface BarRow { id: string; name: string; color: string; value: number; annotation: string }

function BarChart({ rows, xFormat, ariaLabel, height }: { rows: BarRow[]; xFormat: (v: number) => string; ariaLabel: string; height: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const uid = useId().replace(/:/g, "");
  const W = width;
  const H = height;
  let body: ReactNode = null;
  if (W > 0 && rows.length > 0) {
    const xTicks = numericTicks(Math.max(...rows.map((r) => r.value)));
    const xMax = xTicks[xTicks.length - 1] || 1;
    const labelW = Math.max(...rows.map((r) => textWidth(r.name, META_FONT)));
    const annotationW = Math.max(...rows.map((r) => textWidth(r.annotation, META_FONT)));
    const left = Math.ceil(labelW) + 6;
    const right = W - Math.ceil(annotationW) - 6;
    const top = 0;
    const bottom = H - 18;
    const plotW = Math.max(1, right - left);
    const band = (bottom - top) / rows.length;
    const barH = band * 0.6;
    const x = (v: number) => left + (v / xMax) * plotW;
    body = (
      <svg width={W} height={H} style={{ display: "block", overflow: "visible" }} role="img" aria-label={ariaLabel}>
        <defs>
          {rows.map((r, i) => (
            <linearGradient key={r.id} id={`${uid}-b${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: lighten(r.color, 0.18) }} />
              <stop offset="1" style={{ stopColor: r.color }} />
            </linearGradient>
          ))}
        </defs>
        {xTicks.map((v) => (
          <line key={`g${v}`} x1={Math.round(x(v)) + 0.5} x2={Math.round(x(v)) + 0.5} y1={top} y2={bottom} className="rd-grid-07" />
        ))}
        {xTicks.map((v) => {
          const label = xFormat(v);
          const w = textWidth(label, AXIS_FONT);
          const cx = Math.min(Math.max(x(v), w / 2), W - w / 2);
          return <text key={`l${v}`} x={cx} y={bottom + 13} textAnchor="middle" className="rd-axis-label">{label}</text>;
        })}
        {rows.map((r, i) => {
          const cy = top + band * i + band / 2;
          const w = Math.max(0, x(r.value) - left);
          return (
            <g key={r.id}>
              <text x={left - 6} y={cy} textAnchor="end" dominantBaseline="central" className="rd-axis-label rd-axis-meta">{r.name}</text>
              <rect x={left} y={cy - barH / 2} width={w} height={barH} rx={Math.min(5, w / 2)} ry={5} style={{ fill: `url(#${uid}-b${i})` }} />
              <text x={left + w + 4} y={cy} dominantBaseline="central" className="rd-axis-label rd-axis-meta">{r.annotation}</text>
            </g>
          );
        })}
      </svg>
    );
  }
  return <div ref={ref} style={{ width: "100%", minHeight: H }}>{body}</div>;
}
