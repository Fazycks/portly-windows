// Port of Sources/PortlyApp/MemoryDiagnostics.swift plus the value types it reads
// from ProcessMetrics.swift (ProcessMetrics, ManagedProcessSnapshot,
// ExternalProcessSnapshot, ResourcePressure, ProcessDisplayName) and
// Supervisor.swift (ResourceHistoryPoint, ProjectResourceHistoryPoint).
// Pure logic, no React.
import type {
  ExternalProcessSnapshot as ApiExternalProcess,
  ManagedProcessSnapshot as ApiManagedProcess,
} from "./api";

// ---------- Value types (Swift names) ----------

export interface ManagedProcess {
  pid: number;
  parentPID: number;
  command: string;
  displayName: string;
  cpuPercent: number;
  /** Physical footprint (ri_phys_footprint on macOS, private bytes on Windows). */
  memoryBytes: number;
  residentMemoryBytes: number;
  /** How many OS processes this row stands for (1 when the daemon reports per-process rows). */
  processCount: number;
}

export interface ProcessMetrics {
  cpuPercent: number;
  memoryBytes: number;
  residentMemoryBytes: number;
  processCount: number;
  /** Sorted by footprint (desc), then PID — like ProcessMetricsSampler. */
  processes: ManagedProcess[];
}

export interface ExternalProcess {
  pid: number;
  parentPID: number;
  command: string;
  displayName: string;
  cpuPercent: number;
  memoryBytes: number;
  residentMemoryBytes: number;
  parentCommand: string | null;
  workingDirectory: string | null;
  listeningPorts: number[];
  terminationPID: number;
  terminationCommand: string;
  /** Opaque identity token echoed back to /processes/stop. */
  startTime: number;
}

export interface ResourceHistoryPoint {
  id: number;
  timestamp: number; // ms since epoch
  footprintBytes: number;
  residentBytes: number;
  cpuPercent: number;
  processCount: number;
}

export interface ProjectResourceHistoryPoint {
  id: number;
  timestamp: number; // ms since epoch
  projectID: string;
  projectName: string;
  colorHex: string;
  footprintBytes: number;
  residentBytes: number;
}

export type ResourcePressure = "light" | "moderate" | "high";
export const pressureLabel = (p: ResourcePressure) => ({ light: "Light", moderate: "Moderate", high: "High" })[p];

export function cpuPressure(m: { cpuPercent: number }): ResourcePressure {
  if (m.cpuPercent < 35) return "light";
  if (m.cpuPercent < 80) return "moderate";
  return "high";
}

export function memoryPressure(m: { memoryBytes: number }): ResourcePressure {
  if (m.memoryBytes < 256 * 1024 * 1024) return "light";
  if (m.memoryBytes < 1024 * 1024 * 1024) return "moderate";
  return "high";
}

// ---------- ProcessDisplayName ----------

const basename = (path: string) => {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts.length ? parts[parts.length - 1] : path;
};

/** ProcessDisplayName.make, extended for Windows command lines (quoted paths, `.exe`). */
export function processDisplayName(command: string): string {
  const appIndex = command.indexOf(".app/Contents/");
  if (appIndex >= 0) {
    const appPath = command.slice(0, appIndex);
    const slash = appPath.lastIndexOf("/");
    return slash >= 0 ? appPath.slice(slash + 1) : appPath;
  }
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    const exe = end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
    return exe ? basename(exe) : "process";
  }
  // Unquoted Windows paths can contain spaces ("C:\Program Files\...\node.exe arg").
  const exe = /^(.*?\.exe)(?=\s|$)/i.exec(trimmed);
  if (exe) return basename(exe[1]);
  const first = trimmed.split(" ").filter((p) => p.length > 0)[0];
  if (!first) return "process";
  return basename(first);
}

// ---------- API → Swift value types ----------

type ApiManagedMaybeDetailed = ApiManagedProcess & { command?: string; parentPID?: number; name?: string };

/**
 * Groups the daemon's managed snapshots by server into `ProcessMetrics`.
 * The daemon may send one aggregate row per server (processCount > 1) or one row
 * per process; both shapes produce the same totals.
 * `fallbackCommand` supplies a command when the snapshot has none (API gap).
 */
export function metricsByServer(
  managed: ApiManagedProcess[],
  fallbackCommand: (serverID: string) => string,
): Map<string, ProcessMetrics> {
  const result = new Map<string, ProcessMetrics>();
  for (const raw of managed as ApiManagedMaybeDetailed[]) {
    const command = raw.command ?? fallbackCommand(raw.serverID);
    const process: ManagedProcess = {
      pid: raw.pid,
      parentPID: raw.parentPID ?? 0,
      command,
      displayName: raw.name ? raw.name : processDisplayName(command),
      cpuPercent: raw.cpuPercent,
      memoryBytes: raw.footprintBytes,
      residentMemoryBytes: raw.residentBytes,
      processCount: Math.max(1, raw.processCount || 1),
    };
    const m = result.get(raw.serverID) ?? { cpuPercent: 0, memoryBytes: 0, residentMemoryBytes: 0, processCount: 0, processes: [] };
    m.cpuPercent += process.cpuPercent;
    m.memoryBytes += process.memoryBytes;
    m.residentMemoryBytes += process.residentMemoryBytes;
    m.processCount += process.processCount;
    m.processes.push(process);
    result.set(raw.serverID, m);
  }
  for (const m of result.values()) {
    m.processes.sort((a, b) => (a.memoryBytes !== b.memoryBytes ? b.memoryBytes - a.memoryBytes : a.pid - b.pid));
  }
  return result;
}

/** ExternalProcessSnapshot from the daemon, with `parentCommand`/`terminationCommand` recovered from the sample when possible. */
export function externalFromApi(list: ApiExternalProcess[]): ExternalProcess[] {
  const byPID = new Map(list.map((p) => [p.pid, p] as const));
  return list.map((p) => {
    const ext = p as ApiExternalProcess & { parentCommand?: string | null; terminationCommand?: string };
    const parent = byPID.get(p.parentPID);
    const target = byPID.get(p.terminationPID);
    const terminationCommand =
      ext.terminationCommand ?? (p.terminationPID === p.pid ? p.command : target?.command ?? p.terminationName ?? p.command);
    return {
      pid: p.pid,
      parentPID: p.parentPID,
      command: p.command,
      displayName: p.name ? p.name : processDisplayName(p.command),
      cpuPercent: p.cpuPercent,
      memoryBytes: p.footprintBytes,
      residentMemoryBytes: p.residentBytes,
      parentCommand: ext.parentCommand ?? parent?.command ?? null,
      workingDirectory: p.workingDirectory ?? null,
      listeningPorts: [...(p.listeningPorts ?? [])].sort((a, b) => a - b),
      terminationPID: p.terminationPID || p.pid,
      terminationCommand,
      startTime: p.startTime,
    };
  });
}

// ---------- Formatting ----------

/** ByteCountFormatter.string(fromByteCount:countStyle: .memory), spaces made non-breaking. */
export function bytes(value: number): string {
  const v = Math.max(0, Math.round(value));
  let text: string;
  if (v === 0) text = "Zero KB";
  else if (v < 1024) text = `${v} ${v === 1 ? "byte" : "bytes"}`;
  else {
    const units = ["KB", "MB", "GB", "TB", "PB"];
    let amount = v / 1024;
    let i = 0;
    while (amount >= 1024 && i < units.length - 1) { amount /= 1024; i++; }
    // Adaptive: KB → 0 digits, MB → 1, GB and above → 2; trailing zeros dropped.
    const digits = i === 0 ? 0 : i === 1 ? 1 : 2;
    let s = amount.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
    if (s === "1,024" && i < units.length - 1) { s = "1"; i++; }
    text = `${s} ${units[i]}`;
  }
  return text.replace(/ /g, "\u00A0");
}

export const fixed = (value: number, digits: number) =>
  value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const localizedStandardCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

// ---------- MemoryDiagnosticsEngine ----------

export type MemoryDiagnosticSeverity = "healthy" | "notice" | "warning" | "critical";
const severityRank: Record<MemoryDiagnosticSeverity, number> = { healthy: 0, notice: 1, warning: 2, critical: 3 };
export const severityLabel = (s: MemoryDiagnosticSeverity) =>
  ({ healthy: "Healthy", notice: "Review", warning: "High", critical: "Critical" })[s];
export const maxSeverity = (list: MemoryDiagnosticSeverity[]): MemoryDiagnosticSeverity =>
  list.reduce<MemoryDiagnosticSeverity>((a, b) => (severityRank[b] > severityRank[a] ? b : a), "healthy");

export interface MemoryServerDiagnosticSnapshot {
  id: string;
  projectID: string;
  fullName: string;
  metrics: ProcessMetrics;
}

export interface MemoryDiagnostic {
  id: string;
  severity: MemoryDiagnosticSeverity;
  title: string;
  summary: string;
  fix: string;
  serverID: string | null;
  processID: number | null;
}

const MiB = 1_048_576;
const GiB = 1_073_741_824;

const maxBy = <T,>(list: T[], key: (t: T) => number): T | undefined =>
  list.reduce<T | undefined>((best, item) => (best === undefined || key(item) > key(best) ? item : best), undefined);

function groupBy<T>(list: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of list) {
    const k = key(item);
    const arr = m.get(k);
    if (arr) arr.push(item);
    else m.set(k, [item]);
  }
  return m;
}

/** Swift String `<` (Unicode scalar order). */
const stringLess = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function analyze(args: {
  servers: MemoryServerDiagnosticSnapshot[];
  projectHistory: ProjectResourceHistoryPoint[];
  externalProcesses: ExternalProcess[];
  physicalMemoryBytes: number;
}): MemoryDiagnostic[] {
  const { servers, projectHistory, externalProcesses, physicalMemoryBytes } = args;
  const physicalMemory = Math.max(physicalMemoryBytes, 8 * GiB);
  const highServerThreshold = Math.max(GiB, Math.min(2 * GiB, Math.floor(physicalMemory / 10)));
  const criticalServerThreshold = Math.max(2 * GiB, Math.min(4 * GiB, Math.floor(physicalMemory / 5)));
  const largeProcessThreshold = Math.max(512 * MiB, Math.min(1_536 * MiB, Math.floor(physicalMemory / 16)));
  const externalThreshold = Math.max(GiB, Math.min(2 * GiB, Math.floor(physicalMemory / 12)));

  const diagnostics: MemoryDiagnostic[] = [];

  for (const server of [...servers].sort((a, b) => b.metrics.memoryBytes - a.metrics.memoryBytes)) {
    const memory = server.metrics.memoryBytes;
    if (memory >= highServerThreshold) {
      const severity: MemoryDiagnosticSeverity = memory >= criticalServerThreshold ? "critical" : "warning";
      const process = maxBy(server.metrics.processes, (p) => p.memoryBytes);
      diagnostics.push({
        id: `server-${server.id}`,
        severity,
        title: `${server.fullName} owns ${bytes(memory)}`,
        summary: process
          ? `${process.displayName} is the largest child at ${bytes(process.memoryBytes)}. The total includes compressed or swapped pages still owned by this server.`
          : "This server is using an unusually large share of the machine's memory.",
        fix: advice(process?.command ?? "", true),
        serverID: server.id,
        processID: process?.pid ?? null,
      });
      continue;
    }

    const process = server.metrics.processes.find((p) => p.memoryBytes >= largeProcessThreshold);
    if (process) {
      diagnostics.push({
        id: `process-${server.id}-${process.pid}`,
        severity: "notice",
        title: `Large ${process.displayName} process`,
        summary: `PID ${process.pid} owns ${bytes(process.memoryBytes)} inside ${server.fullName}.`,
        fix: advice(process.command, true),
        serverID: server.id,
        processID: process.pid,
      });
    }
  }

  diagnostics.push(...growthDiagnostics(servers, projectHistory));

  const managedPIDs = new Set(servers.flatMap((s) => s.metrics.processes.map((p) => p.pid)));
  const heavyExternal = externalProcesses
    .filter((p) => !managedPIDs.has(p.pid) && p.memoryBytes >= externalThreshold)
    .slice(0, 3);
  for (const process of heavyExternal) {
    diagnostics.push({
      id: `external-${process.pid}`,
      severity: process.memoryBytes >= externalThreshold * 2 ? "warning" : "notice",
      title: `${process.displayName} is heavy outside Portly`,
      summary: `PID ${process.pid} owns ${bytes(process.memoryBytes)} and uses ${bytes(process.residentMemoryBytes)} of RAM. Portly will not stop it automatically.`,
      fix: advice(process.command, false),
      serverID: null,
      processID: process.pid,
    });
  }

  diagnostics.push(...duplicateDevProcessDiagnostics(externalProcesses));

  if (diagnostics.length === 0) {
    return [
      {
        id: "healthy",
        severity: "healthy",
        title: "Memory use looks healthy",
        summary: "No managed server is above its machine-adjusted limit and no sustained growth is visible in the recent window.",
        fix: "Keep this dashboard open while reproducing a slowdown. Portly will surface a new recommendation as soon as the pattern becomes significant.",
        serverID: null,
        processID: null,
      },
    ];
  }

  return diagnostics
    .sort((a, b) =>
      a.severity !== b.severity ? severityRank[b.severity] - severityRank[a.severity] : stringLess(a.id, b.id),
    )
    .slice(0, 8);
}

function growthDiagnostics(
  servers: MemoryServerDiagnosticSnapshot[],
  history: ProjectResourceHistoryPoint[],
): MemoryDiagnostic[] {
  const serversByProject = groupBy(servers, (s) => s.projectID);
  const result: MemoryDiagnostic[] = [];
  for (const [projectID, points] of groupBy(history, (p) => p.projectID)) {
    const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
    if (sorted.length < 8) continue;
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    const duration = (last.timestamp - first.timestamp) / 1000;
    if (duration < 20) continue;

    const windowSize = Math.max(2, Math.floor(sorted.length / 4));
    const baseline = median(sorted.slice(0, windowSize).map((p) => p.footprintBytes));
    const recent = median(sorted.slice(-windowSize).map((p) => p.footprintBytes));
    if (!(recent > baseline)) continue;

    const growth = recent - baseline;
    const requiredGrowth = Math.max(256 * MiB, Math.floor(baseline / 3));
    const bytesPerSecond = growth / duration;
    if (!(growth >= requiredGrowth && bytesPerSecond >= 2 * MiB)) continue;

    const projectServers = serversByProject.get(projectID) ?? [];
    const largestServer = maxBy(projectServers, (s) => s.metrics.memoryBytes);
    const largestProcess = largestServer ? maxBy(largestServer.metrics.processes, (p) => p.memoryBytes) : undefined;
    const severity: MemoryDiagnosticSeverity = growth >= 768 * MiB ? "critical" : "warning";

    result.push({
      id: `growth-${projectID}`,
      severity,
      title: `${last.projectName} keeps growing`,
      summary: `Footprint rose by ${bytes(growth)} over ${fixed(duration, 0)} seconds; the signal uses early and recent medians to ignore one-off build spikes.`,
      fix: advice(largestProcess?.command ?? "", true),
      serverID: largestServer?.id ?? null,
      processID: largestProcess?.pid ?? null,
    });
  }
  return result;
}

function duplicateDevProcessDiagnostics(processes: ExternalProcess[]): MemoryDiagnostic[] {
  const candidates: [string, ExternalProcess][] = [];
  for (const process of processes) {
    const family = devFamily(process.command);
    if (family) candidates.push([family, process]);
  }
  const result: MemoryDiagnostic[] = [];
  for (const [family, entries] of groupBy(candidates, (c) => c[0])) {
    if (entries.length < 2) continue;
    const total = entries.reduce((sum, e) => sum + e[1].memoryBytes, 0);
    if (total < 768 * MiB) continue;
    const pids = entries.slice(0, 4).map((e) => String(e[1].pid)).join(", ");
    result.push({
      id: `duplicate-${family}`,
      severity: "notice",
      title: `Multiple ${family} sessions run outside Portly`,
      summary: `${entries.length} related processes own ${bytes(total)} in total (PIDs ${pids}). Some may be stale or duplicate dev servers.`,
      fix: "Close stale sessions, then register each persistent dev server in Portly so its full process tree can be stopped and monitored safely.",
      serverID: null,
      processID: entries[0]?.[1].pid ?? null,
    });
  }
  return result;
}

export function advice(command: string, managed: boolean): string {
  const lower = command.toLowerCase();
  const looksLikeDevProcess =
    lower.includes("node_modules") ||
    lower.includes("next-server") ||
    lower.includes("next dev") ||
    lower.includes("vite") ||
    lower.includes("pnpm") ||
    lower.includes("npm run");
  let prefix: string;
  if (managed) prefix = "Restart the server to reclaim memory now. ";
  else if (looksLikeDevProcess)
    prefix = "Stop the parent dev session, not only this child, then move it under Portly if it should stay running. ";
  else prefix = "Quit or restart the owning app after saving your work. ";

  if (lower.includes("next-server") || lower.includes("next/dist") || lower.includes("next\\dist") || lower.includes("next dev")) {
    return prefix + "If it grows again, check for duplicate Next.js dev sessions, import cycles, oversized source maps, and directories watched inside generated output.";
  }
  if (lower.includes("vite")) {
    return prefix + "If it grows again, inspect Vite plugin caches and watcher loops, and exclude generated or build directories from file watching.";
  }
  if (lower.includes("tsserver") || lower.includes("typescript")) {
    return prefix + "Restart the TypeScript service, then exclude generated folders and large artifacts from the workspace if usage climbs back.";
  }
  if (lower.includes("chrome") || lower.includes("chromium")) {
    return prefix + "Close stale tabs and DevTools windows, then review extensions or tab memory if the same process becomes heavy again.";
  }
  if (lower.includes("docker") || lower.includes("com.docker")) {
    return prefix + "Stop unused containers and set explicit container memory limits before restarting the workload.";
  }
  if (lower.includes("redis")) {
    return prefix + "Inspect key count, eviction policy, and maxmemory; a restart only clears the symptom if the dataset immediately grows back.";
  }
  if (lower.includes("postgres")) {
    return prefix + "Inspect shared_buffers, connection count, and expensive sessions before raising memory limits.";
  }
  if (lower.includes("node") || lower.includes("pnpm") || lower.includes("npm") || lower.includes("bun")) {
    return prefix + "If usage returns, capture a heap snapshot with the runtime inspector and look for retained caches, listeners, or duplicated workers. Use a heap limit only as a safety rail.";
  }
  return prefix + "If memory quickly returns, profile allocations and check for retained caches, background workers, or duplicate instances before increasing limits.";
}

function devFamily(command: string): string | null {
  const lower = command.toLowerCase();
  // Count launchers rather than workers. A single Next.js session normally
  // contains both `next dev` and `next-server`; treating both as sessions
  // would create a false duplicate warning.
  if (lower.includes("next-server")) return null;
  if (lower.includes("next/dist") || lower.includes("next\\dist") || lower.includes("next dev")) return "Next.js";
  if (lower.includes("vite")) return "Vite";
  if (lower.includes("convex dev")) return "Convex";
  if (lower.includes("pnpm") && lower.includes(" dev")) return "pnpm dev";
  if (lower.includes("npm") && lower.includes(" dev")) return "npm dev";
  return null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return Math.floor(sorted[middle - 1] / 2) + Math.floor(sorted[middle] / 2);
  return sorted[middle];
}

// ---------- DashboardProjectChartStyleScale ----------

export interface DashboardProjectChartStyle {
  id: string;
  name: string;
  colorHex: string;
  /** Second encoding channel; empty means solid. */
  dash: number[];
}

/** Cycled alongside the color so every series carries a shape as well as a hue. */
export const dashPatterns: number[][] = [[], [6, 3], [1.5, 3], [9, 3, 1.5, 3]];

export function makeChartStyles(
  history: ProjectResourceHistoryPoint[],
  activeProjects: { id: string; name: string; colorHex: string }[],
): DashboardProjectChartStyle[] {
  const namesByID = new Map<string, { name: string; colorHex: string }>();
  for (const point of history) namesByID.set(point.projectID, { name: point.projectName, colorHex: point.colorHex });
  // Current configuration wins when a project was renamed or recolored,
  // while stopped projects remain in the domain until their history ages out.
  for (const project of activeProjects) namesByID.set(project.id, { name: project.name, colorHex: project.colorHex });
  // Sorted by name, not by footprint, so a project keeps the same dash pattern.
  const ordered = [...namesByID.entries()].sort((a, b) => {
    const nameOrder = localizedStandardCompare(a[1].name, b[1].name);
    if (nameOrder !== 0) return nameOrder;
    return stringLess(a[0], b[0]);
  });
  return ordered.map(([id, v], index) => ({ id, name: v.name, colorHex: v.colorHex, dash: dashPatterns[index % dashPatterns.length] }));
}
