// Typed client for the Portly control API (Go daemon, 127.0.0.1:7737).
// Mirrors cli/models.go. Windows-only additions are marked "win".

export type ServerState = "stopped" | "starting" | "running" | "unhealthy" | "restarting" | "failed";
export type MemoryLimitMode = "inherit" | "disabled" | "custom";
export type TemporaryJobState = "running" | "succeeded" | "failed" | "timedOut" | "stopped";

export const isActiveState = (s: ServerState) =>
  s === "starting" || s === "running" || s === "unhealthy" || s === "restarting";

export interface ServerAction { name: string; command: string }

export interface ServerConfig {
  id: string;
  name: string;
  command: string;
  port: number | null;
  directory: string | null;
  env: Record<string, string>;
  healthURL: string | null;
  healthStatus: number | null;
  autoRestart: boolean;
  actions: ServerAction[];
  idleTimeoutSeconds?: number | null;
}

export interface Project {
  id: string;
  name: string;
  icon: string;
  color: string;
  root: string;
  servers: ServerConfig[];
  memoryLimitMode: MemoryLimitMode;
  memoryLimitBytes: number | null;
}

export interface PortlyConfig {
  version: number;
  apiPort: number;
  healthIntervalSeconds: number;
  maxRestartAttempts: number;
  logBufferLines: number;
  logFileMaxMB: number;
  globalMemoryLimitBytes?: number | null;
  idleTimeoutSeconds?: number | null;
  projects: Project[];
}

export interface ServerStatus {
  id: string;
  name: string;
  projectID: string;
  projectName: string;
  command: string;
  port: number | null;
  directory: string;
  state: ServerState;
  pid: number | null;
  startedAt: string | null;
  restartCount: number;
  lastExitCode: number | null;
  lastError: string | null;
  healthy: boolean;
  url: string | null;
  cpuPercent?: number;
  memoryBytes?: number;
  residentMemoryBytes?: number;
  processCount?: number;
  temporary?: boolean;
  timeoutSeconds?: number;
  deadline?: string;
  finishedAt?: string;
  timedOut?: boolean;
  idleTimeoutSeconds?: number;
  lastActivityAt?: string;
  idleStoppedAt?: string;
}

export interface ProjectStatus {
  id: string;
  name: string;
  icon: string;
  color: string;
  root: string;
  servers: ServerStatus[];
  memoryLimitMode: MemoryLimitMode;
  memoryLimitBytes?: number;
  effectiveMemoryLimitBytes?: number;
  lastMemoryRestartAt?: string;
  lastMemoryRestartBytes?: number;
}

export interface PortlyStatus {
  version: string;
  apiPort: number;
  globalMemoryLimitBytes?: number;
  globalIdleTimeoutSeconds?: number;
  projects: ProjectStatus[];
  temporaryServers: ServerStatus[];
}

export interface PortOccupant {
  port: number;
  pid: number;
  command: string;
  user: string;
  ownedByPortly: boolean;
  serverID: string | null;
  dockerContainerID?: string;
  dockerContainerName?: string;
  dockerComposeProject?: string;
  dockerComposeService?: string;
}

export interface ActionResponse { affected: string[]; message: string }

// win: every TCP listener on the machine (PortsView).
export interface Listener {
  port: number;
  pid: number;
  command: string;
  user: string;
  address: string;
  executable?: string;
  workingDirectory?: string;
  dockerContainerID?: string;
  dockerContainerName?: string;
  dockerComposeProject?: string;
  dockerComposeService?: string;
}

// win: process sample for the Resources screen (ProcessMetrics.swift port).
export interface ManagedProcessSnapshot {
  serverID: string;
  pid: number;
  footprintBytes: number;
  residentBytes: number;
  cpuPercent: number;
  processCount: number;
}

export interface ExternalProcessSnapshot {
  pid: number;
  parentPID: number;
  name: string;
  command: string;
  footprintBytes: number;
  residentBytes: number;
  cpuPercent: number;
  startTime: number; // opaque identity token, echoed back to /processes/stop
  executable?: string;
  workingDirectory?: string;
  listeningPorts: number[];
  terminationPID: number;
  terminationName: string;
  isDevLauncher: boolean;
}

export interface ResourceSample {
  sampledAt: string;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  cpuCount: number;
  managed: ManagedProcessSnapshot[];
  external: ExternalProcessSnapshot[];
}

// win: raw terminal output since an offset (for xterm.js).
export interface OutputChunk { offset: number; data: string; reset: boolean }

// win: command detection for the Add Server form (CommandDetector.swift port).
export interface DetectedCommand {
  name: string;
  command: string;
  port: number | null;
  source: string;
  directory?: string | null;
}

// win: agent onboarding (AgentSetup.swift port).
export interface AgentSetupStatus {
  cliInstalled: boolean;
  cliPath: string | null;
  skillInstalled: boolean;
  agentsRulesInstalled: boolean;
  claudeRulesInstalled: boolean;
  complete: boolean;
}

export interface ForeverState {
  enabled: boolean;
  loaded: boolean;
  label: string;
  unit: string;
  daemonExecutable: string;
}

export const API_PORT = 7737;
let base = `http://127.0.0.1:${API_PORT}`;
export const setApiPort = (port: number) => { base = `http://127.0.0.1:${port}`; };

export class ApiError extends Error {}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}/${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new ApiError("Cannot reach Portly");
  }
  const env = await res.json().catch(() => null);
  if (!env || !env.ok) throw new ApiError(env?.error ?? `HTTP ${res.status}`);
  return env.data as T;
}

const q = encodeURIComponent;

export const api = {
  ping: () => call<{ pong: string }>("GET", "ping"),
  status: () => call<PortlyStatus>("GET", "status"),
  config: () => call<PortlyConfig>("GET", "config"),
  logs: (server: string, tail = 200) => call<{ server: string; lines: string[] }>("GET", `logs?server=${q(server)}&tail=${tail}`),
  port: (port: number) => call<{ port: number; occupant: PortOccupant | null }>("GET", `ports?port=${port}`),

  start: (target: { server?: string; project?: string }) => call<ActionResponse>("POST", "start", target),
  stop: (target: { server?: string; project?: string }) => call<ActionResponse>("POST", "stop", target),
  restart: (target: { server?: string; project?: string }) => call<ActionResponse>("POST", "restart", target),
  stopAll: () => call<ActionResponse>("POST", "stop", {}),

  addProject: (p: { name: string; root: string; icon?: string; color?: string; memoryLimitMode?: MemoryLimitMode; memoryLimitBytes?: number | null }) =>
    call<Project>("POST", "projects/add", p),
  // win: edit name/root/icon/color.
  updateProject: (p: { project: string; name?: string; root?: string; icon?: string; color?: string }) =>
    call<ActionResponse>("POST", "projects/update", p),
  removeProject: (project: string) => call<ActionResponse>("POST", "projects/remove", { project }),

  addServer: (s: Partial<ServerConfig> & { project: string; name: string; command: string; start?: boolean }) =>
    call<ServerConfig>("POST", "servers/add", s),
  updateServer: (s: Partial<ServerConfig> & { server: string }) => call<ActionResponse>("POST", "servers/update", s),
  removeServer: (server: string) => call<ActionResponse>("POST", "servers/remove", { server }),
  takeOver: (server: string) => call<ActionResponse>("POST", "servers/take-over", { server }),

  runTemporary: (t: { name: string; command: string; directory: string; port?: number | null; env?: Record<string, string>; timeoutSeconds?: number }) =>
    call<{ id: string }>("POST", "temporary/run", t),
  runAction: (server: string, action: string, timeoutSeconds?: number) =>
    call<{ id: string }>("POST", "actions/run", { server, action, timeoutSeconds }),

  memoryLimit: (body: { project?: string; mode: MemoryLimitMode; bytes?: number | null }) => call<ActionResponse>("POST", "memory-limit", body),
  idleTimeout: (body: { server?: string; seconds?: number | null }) => call<ActionResponse>("POST", "idle-timeout", body),
  killPort: (port: number) => call<ActionResponse>("POST", "ports/kill", { port }),
  quit: () => call<ActionResponse>("POST", "quit", {}),

  // win additions
  listeners: () => call<Listener[]>("GET", "listeners"),
  resources: () => call<ResourceSample>("GET", "resources"),
  stopProcess: (pid: number, startTime: number) => call<ActionResponse>("POST", "processes/stop", { pid, startTime }),
  updateSettings: (s: Partial<Pick<PortlyConfig, "healthIntervalSeconds" | "maxRestartAttempts" | "logBufferLines" | "logFileMaxMB" | "apiPort">>) =>
    call<PortlyConfig>("POST", "config/update", s),
  output: (server: string, since: number, signal?: AbortSignal) =>
    call<OutputChunk>("GET", `output?server=${q(server)}&since=${since}&wait=1`, undefined, signal),
  input: (server: string, data: string) => call<ActionResponse>("POST", "input", { server, data }),
  resize: (server: string, cols: number, rows: number) => call<ActionResponse>("POST", "resize", { server, cols, rows }),
  clearOutput: (server: string) => call<ActionResponse>("POST", "output/clear", { server }),
  detect: (path: string) => call<DetectedCommand[]>("GET", `detect?path=${q(path)}`),
  nextPort: (start = 3000, excluding?: string) =>
    call<{ port: number }>("GET", `next-port?start=${start}${excluding ? `&excluding=${q(excluding)}` : ""}`),
  agentSetupStatus: () => call<AgentSetupStatus>("GET", "agent-setup"),
  agentSetupInstall: () => call<AgentSetupStatus>("POST", "agent-setup", {}),
  foreverStatus: () => call<ForeverState>("GET", "forever"),
  foreverSet: (enabled: boolean) => call<ForeverState>("POST", "forever", { enabled }),
};
