// Derived values the Swift views read from ServerRuntime / ProcessMetrics,
// rebuilt from the daemon's ServerStatus, plus the few SF Symbols the shared
// table does not map yet.
import { Clock, Eraser, Hash, Plus, Timer, type LucideIcon, type LucideProps } from "lucide-react";
import { isActiveState, type ServerStatus, type TemporaryJobState } from "../lib/api";
import { Symbol } from "../lib/symbols";
import type { Pressure } from "../components/ui";

const extra: Record<string, LucideIcon> = {
  plus: Plus,
  eraser: Eraser,
  number: Hash,
  clock: Clock,
  timer: Timer,
};

/** `Image(systemName:)` — the shared table, plus local fallbacks for names it lacks. */
export function Icon({ name, size = 13, ...rest }: { name: string; size?: number } & Omit<LucideProps, "size">) {
  const E = extra[name];
  if (E) return <E size={Math.round(size * 1.05)} strokeWidth={size <= 10 ? 2.6 : 2} aria-hidden {...rest} />;
  return <Symbol name={name} size={size} {...rest} />;
}

export const isRunning = (s: ServerStatus) => isActiveState(s.state);

/** ServerRuntime.url */
export const serverURL = (s: ServerStatus) => s.url ?? (s.port != null ? `http://localhost:${s.port}` : null);

export interface JobStatus {
  state: TemporaryJobState;
  timeoutSeconds: number;
  exitCode: number | null;
  elapsedSeconds: number | null;
}

/** ServerRuntime.temporaryJobStatus */
export function jobStatus(s: ServerStatus): JobStatus | null {
  if (s.timeoutSeconds == null) return null;
  let state: TemporaryJobState;
  if (s.timedOut) state = "timedOut";
  else if (isRunning(s)) state = "running";
  else if (s.state === "failed" || (s.lastExitCode != null && s.lastExitCode !== 0)) state = "failed";
  else if (s.lastExitCode === 0) state = "succeeded";
  else state = "stopped";
  const elapsedSeconds = s.startedAt
    ? ((s.finishedAt ? new Date(s.finishedAt).getTime() : Date.now()) - new Date(s.startedAt).getTime()) / 1000
    : null;
  return { state, timeoutSeconds: s.timeoutSeconds, exitCode: s.lastExitCode, elapsedSeconds };
}

/** TemporaryTimeout.display */
export function timeoutDisplay(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** ProcessMetrics is present when the daemon reports a sample. */
export const hasMetrics = (s: ServerStatus) => s.memoryBytes != null || s.cpuPercent != null;

export function memoryPressure(bytes: number): Pressure {
  if (bytes < 256 * 1024 * 1024) return "light";
  if (bytes < 1024 * 1024 * 1024) return "moderate";
  return "high";
}

export function cpuPressure(pct: number): Pressure {
  if (pct < 35) return "light";
  if (pct < 80) return "moderate";
  return "high";
}

export const pressureLabel = (p: Pressure) => ({ light: "Light", moderate: "Moderate", high: "High" })[p];

/** NSString.abbreviatingWithTildeInPath, for Windows profile paths. */
export function abbreviatePath(path: string): string {
  return path.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=$|[\\/])/i, "~");
}
