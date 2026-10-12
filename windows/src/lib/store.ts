// Shared polling store over the daemon API. Every window (main, popover,
// settings) runs its own instance; the daemon is the single source of truth,
// exactly like the macOS app where every view observes `Supervisor.shared`.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api, isActiveState, type PortlyConfig, type PortlyStatus, type ServerStatus } from "./api";

type Snapshot = {
  status: PortlyStatus | null;
  config: PortlyConfig | null;
  connected: boolean;
  error: string | null;
};

let snapshot: Snapshot = { status: null, config: null, connected: false, error: null };
const listeners = new Set<() => void>();
let timer: number | undefined;
let inflight = false;

function emit(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

export async function refresh() {
  if (inflight) return;
  inflight = true;
  try {
    const [status, config] = await Promise.all([api.status(), api.config()]);
    emit({ status, config, connected: true, error: null });
  } catch (e) {
    emit({ connected: false, error: (e as Error).message });
  } finally {
    inflight = false;
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1) {
    void refresh();
    timer = window.setInterval(refresh, 1000);
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) window.clearInterval(timer);
  };
}

export function usePortly(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** Run a mutating API call, then refresh immediately so the UI reacts without waiting a tick. */
export async function act<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    void refresh();
  }
}

export function allServers(status: PortlyStatus | null): ServerStatus[] {
  return status?.projects.flatMap((p) => p.servers) ?? [];
}

/** Supervisor.runningCount / hasProblem equivalents. */
export function useCounts() {
  const { status } = usePortly();
  return useMemo(() => {
    const servers = allServers(status);
    const running = servers.filter((s) => isActiveState(s.state)).length;
    const problem = servers.some((s) => s.state === "failed" || s.state === "unhealthy");
    return { total: servers.length, running, problem };
  }, [status]);
}

/** Re-render every `ms` (uptime labels, relative times). */
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => set((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}
