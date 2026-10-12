// Port of ServerDetail.swift — the terminal plus everything you need to act on
// one server.
import { useCallback, useEffect, useState } from "react";
import { api, type PortOccupant, type ServerAction, type ServerStatus } from "../lib/api";
import { act, usePortly, useTick } from "../lib/store";
import { openExternal } from "../lib/native";
import { Alert, Button, Divider, StatusBadge, T, compactUptime, formatBytes, pressureColor } from "../components/ui";
import TerminalPane from "./TerminalPane";
import { DetailToolbar, ToolbarButton, ToolbarMenu } from "./Toolbar";
import {
  Icon, cpuPressure, hasMetrics, isRunning, jobStatus, memoryPressure, serverURL, timeoutDisplay, type JobStatus,
} from "./serverInfo";
import "./ServerDetail.css";

export default function ServerDetail({ server, actions, onEdit, onShowResources }: {
  server: ServerStatus;
  /** runtime.config.actions */
  actions: ServerAction[];
  onEdit: (() => void) | null;
  /** AppSelection.shared.pending = .resources */
  onShowResources: () => void;
}) {
  const { config } = usePortly();
  useTick(1000);
  const [conflict, setConflict] = useState<PortOccupant | null>(null);
  const [showsResources, setShowsResources] = useState(false);
  const [conflictActionError, setConflictActionError] = useState<string | null>(null);
  const [clearToken, setClearToken] = useState(0);

  const running = isRunning(server);
  const job = jobStatus(server);
  const url = serverURL(server);
  const stopped = server.state === "stopped";

  /** Only interesting when our own server is not the listener. */
  const refreshConflict = useCallback(() => {
    if (server.port == null || running) {
      setConflict(null);
      return;
    }
    api.port(server.port).then((r) => setConflict(r.occupant)).catch(() => setConflict(null));
  }, [server.port, running]);

  useEffect(() => { refreshConflict(); }, [server.id, server.state, refreshConflict]);

  const start = () => void act(() => api.start({ server: server.id }));
  const stop = () => void act(() => api.stop({ server: server.id }));

  const stopConflictOwner = async (occupant: PortOccupant) => {
    try {
      await act(() => api.killPort(occupant.port));
      await new Promise((r) => setTimeout(r, 500));
      refreshConflict();
    } catch (e) {
      setConflictActionError((e as Error).message);
    }
  };

  const takeOverPort = async () => {
    try {
      await act(() => api.takeOver(server.id));
      setConflict(null);
    } catch (e) {
      setConflictActionError((e as Error).message);
    }
  };

  const clearTerminal = () => {
    setClearToken((n) => n + 1);
    api.clearOutput(server.id).catch(() => {});
  };

  const visibleConflict = conflict && !conflict.ownedByPortly ? conflict : null;

  return (
    <div className="server-detail">
      <DetailToolbar title={server.name} subtitle={server.projectName}>
        <ToolbarButton
          symbol={running ? "stop.fill" : server.state === "failed" ? "arrow.clockwise" : "play.fill"}
          label={running ? "Stop" : server.state === "failed" ? "Retry" : "Start"}
          help={running ? "Stop the server" : server.state === "failed" ? "Reset retries and start the server" : "Start the server"}
          onClick={running ? stop : start}
        />
        {running && (
          <ToolbarButton symbol="arrow.clockwise" label="Restart" help="Restart the server"
            onClick={() => void act(() => api.restart({ server: server.id }))} />
        )}
        {actions.length > 0 && (
          <ToolbarMenu
            symbol="bolt.fill"
            label="Actions"
            help="Run a maintenance action without restarting the server"
            items={actions.map((a) => ({ label: a.name, onClick: () => void act(() => api.runAction(server.id, a.name)) }))}
          />
        )}
        {url && <ToolbarButton symbol="safari" label="Open" help={`Open ${url}`} onClick={() => void openExternal(url)} />}
        {!stopped && <ToolbarButton symbol="eraser" label="Clear" help="Clear the terminal" onClick={clearTerminal} />}
        {onEdit && <ToolbarButton symbol="slider.horizontal.3" label="Edit" help="Edit this server" onClick={onEdit} />}
      </DetailToolbar>

      <div className="server-detail-body">
        {/* Info bar */}
        <div className="info-bar">
          <div className="info-bar-row">
            <StatusBadge state={server.state} />
            {server.pid != null && <Fact text={`PID ${server.pid}`} symbol="number" />}
            {server.port != null && <Fact text={`Port ${server.port}`} symbol="network" />}
            {server.startedAt && running && <Fact text={`Up ${compactUptime(server.startedAt)}`} symbol="clock" />}
            {job && <Fact text={jobFact(job)} symbol={job.state === "running" ? "timer" : "checkmark.circle"} />}
            {server.restartCount > 0 && (
              <Fact text={`${server.restartCount}/${config?.maxRestartAttempts ?? 5} restarts`} symbol="arrow.clockwise" />
            )}
            {running && server.idleTimeoutSeconds != null && (
              <Fact text={`Idle stop ${timeoutDisplay(server.idleTimeoutSeconds)}`} symbol="moon.zzz" />
            )}

            <div className="info-bar-spacer" />

            {server.lastError && (
              <span
                className="info-bar-error"
                style={{ color: server.idleStoppedAt == null ? "var(--sys-red)" : "var(--secondary-label)" }}
                title={server.lastError}
              >
                {server.lastError}
              </span>
            )}

            {hasMetrics(server) && (
              <button
                className={`resource-toggle${showsResources ? " on" : ""}`}
                title={showsResources ? "Hide resource use" : "Show resource use"}
                aria-label={showsResources ? "Hide resource use" : "Show resource use"}
                onClick={() => setShowsResources((v) => !v)}
              >
                <Icon name="chart.bar.xaxis" size={13} />
              </button>
            )}
          </div>

          {hasMetrics(server) && showsResources && (
            <div className="info-bar-resources">
              <CompactResource
                value={`${(server.cpuPercent ?? 0).toFixed(1)}%`}
                symbol="cpu"
                color={pressureColor(cpuPressure(server.cpuPercent ?? 0))}
                label="CPU"
                help="Total CPU used by this server and its child processes"
              />
              <CompactResource
                value={formatBytes(server.memoryBytes ?? 0)}
                symbol="memorychip"
                color={pressureColor(memoryPressure(server.memoryBytes ?? 0))}
                label="Memory"
                help="Total memory owned by this server and its child processes"
              />
              <CompactResource
                value={String(server.processCount ?? 1)}
                symbol="square.stack.3d.up"
                color="var(--sys-blue)"
                label="Processes"
                help="Processes Portly groups together for this server"
              />
              <div className="info-bar-spacer" />
              <Button variant="borderless" className="details-button" help="Open the resource dashboard" onClick={onShowResources}>
                <Icon name="arrow.up.right" size={13} />
                <span>Details</span>
              </Button>
            </div>
          )}
        </div>
        <Divider />

        {/* Port conflict */}
        {visibleConflict && (
          <div className="conflict-wrap">
            <div className="conflict-banner">
              <Icon name="exclamationmark.triangle.fill" size={13} style={{ color: "var(--sys-orange)", flex: "none" }} />
              <div className="conflict-text">
                <div className="conflict-title">
                  {visibleConflict.dockerContainerID == null ? "Running outside Portly" : "Docker container outside Portly"}
                </div>
                <div className="conflict-desc selectable">{conflictDescription(visibleConflict)}</div>
              </div>
              <div className="info-bar-spacer" />
              <Button size="small" onClick={() => void stopConflictOwner(visibleConflict)}>
                {visibleConflict.dockerContainerID == null ? "Stop process" : "Stop container"}
              </Button>
              <Button
                size="small"
                help={`Stop the current owner safely, then start ${server.projectName} / ${server.name} under Portly`}
                onClick={() => void takeOverPort()}
              >
                Move to Portly
              </Button>
            </div>
            <Divider />
          </div>
        )}

        {stopped ? (
          <StoppedState key="stopped" server={server} job={job} onStart={start} />
        ) : (
          <div key="terminal" className="pane-swap terminal-wrap">
            <TerminalPane key={server.id} serverId={server.id} clearToken={clearToken} />
          </div>
        )}
      </div>

      <Alert
        open={conflictActionError != null}
        title="Unable to stop port owner"
        message={conflictActionError ?? "The port owner could not be stopped."}
        actions={[{ label: "OK", role: "default", onClick: () => setConflictActionError(null) }]}
      />
    </div>
  );
}

function StoppedState({ server, job, onStart }: { server: ServerStatus; job: JobStatus | null; onStart: () => void }) {
  const icon = job?.state === "succeeded" ? "checkmark.circle" : job?.state === "failed" || job?.state === "timedOut" ? "xmark.circle" : "terminal";
  const title = !job
    ? "Server is stopped"
    : ({ succeeded: "Job succeeded", failed: "Job failed", timedOut: "Job timed out", stopped: "Job stopped", running: "Job is running" } as const)[job.state];
  let message: string;
  if (!job) {
    message = `Start ${server.name} to see its live terminal output.`;
  } else {
    const duration = job.elapsedSeconds != null ? `${job.elapsedSeconds.toFixed(1)} seconds` : "an unknown duration";
    const exitCode = job.exitCode != null ? ` with exit code ${job.exitCode}` : "";
    message = `Finished in ${duration}${exitCode}. Its captured output remains available here for one hour.`;
  }
  return (
    <div className="pane-swap stopped-state">
      <Icon
        name={icon}
        size={32}
        strokeWidth={1.25}
        style={{ color: job?.state === "succeeded" ? "var(--sys-green)" : "var(--secondary-label)" }}
      />
      <div className="stopped-texts">
        <div style={T.title}>{title}</div>
        <div style={T.body} className="secondary">{message}</div>
      </div>
      <Button variant="prominent" size="large" onClick={onStart}>
        <Icon name="play.fill" size={13} />
        <span>{job ? "Run Again" : "Start"}</span>
      </Button>
    </div>
  );
}

function Fact({ text, symbol }: { text: string; symbol: string }) {
  return (
    <span className="fact digits" style={T.metadata}>
      <Icon name={symbol} size={10.5} />
      <span>{text}</span>
    </span>
  );
}

function jobFact(job: JobStatus): string {
  switch (job.state) {
    case "running": return `Timeout ${timeoutDisplay(job.timeoutSeconds)}`;
    case "succeeded": return "Succeeded";
    case "failed": return job.exitCode != null ? `Failed · exit ${job.exitCode}` : "Failed";
    case "timedOut": return `Timed out · ${timeoutDisplay(job.timeoutSeconds)}`;
    case "stopped": return "Stopped";
  }
}

function CompactResource({ value, symbol, color, label, help }: { value: string; symbol: string; color: string; label: string; help: string }) {
  return (
    <span className="compact-resource" title={help} aria-label={`${label}, ${value}`}>
      <Icon name={symbol} size={11} strokeWidth={2.2} style={{ color }} />
      <span className="digits" style={T.metric}>{value}</span>
    </span>
  );
}

function conflictDescription(o: PortOccupant): string {
  if (o.dockerContainerName) {
    const service = [o.dockerComposeProject, o.dockerComposeService].filter(Boolean).join(" / ");
    const identity = service || o.dockerContainerName;
    return `${identity} publishes port ${o.port} through Docker Desktop (backend pid ${o.pid}).`;
  }
  return `${o.command} (pid ${o.pid}) is using port ${o.port}.`;
}
