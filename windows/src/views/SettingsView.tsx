// Port of SettingsView.swift: a Settings window (680×560) with the macOS toolbar
// tab style — General, Servers, Memory, Inactivity — and the MemoryLimitEditor sheet.
// Windows nouns: menu bar → system tray, Dock → taskbar.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, isActiveState, type MemoryLimitMode, type Project, type ServerConfig, type ServerStatus } from "../lib/api";
import { act, usePortly } from "../lib/store";
import { native, onSettingsTab, usePrefs } from "../lib/native";
import { Symbol } from "../lib/symbols";
import { Alert, Button, Form, Picker, Row, Section, Sheet, Stepper, T, Toggle, hexColor, Divider } from "../components/ui";
import { BUSY_CPU_PERCENT, FieldRow, LabelRow, TextRow, describeIdle, displayMemory, idleChoices, parseMemorySize } from "./Forms";
import "./SettingsView.css";

type Tab = "general" | "servers" | "memory" | "inactivity";
const TABS: { id: Tab; label: string; symbol: string }[] = [
  { id: "general", label: "General", symbol: "gearshape" },
  { id: "servers", label: "Servers", symbol: "server.rack" },
  { id: "memory", label: "Memory", symbol: "memorychip" },
  { id: "inactivity", label: "Inactivity", symbol: "moon.zzz" },
];
const isTab = (v: string): v is Tab => TABS.some((t) => t.id === v);

function initialTab(): Tab {
  const hash = window.location.hash.toLowerCase();
  return TABS.find((t) => hash.includes(t.id))?.id ?? "general";
}

export default function SettingsView() {
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    onSettingsTab((t) => { if (isTab(t)) setTab(t); }).then((u) => { if (disposed) u(); else un = u; }).catch(() => {});
    return () => { disposed = true; un?.(); };
  }, []);

  // The macOS Settings window titles itself after the selected tab.
  useEffect(() => {
    document.title = TABS.find((t) => t.id === tab)?.label ?? "Settings";
  }, [tab]);

  return (
    <div className="st-root">
      <div className="st-toolbar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`st-tab${tab === t.id ? " selected" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span className="st-tab-icon"><Symbol name={t.symbol} size={20} strokeWidth={1.8} /></span>
            <span className="st-tab-label">{t.label}</span>
          </button>
        ))}
      </div>
      <div className="st-content">
        {tab === "general" && <GeneralSettingsView />}
        {tab === "servers" && <RuntimeSettingsView />}
        {tab === "memory" && <MemoryGuardSettingsView />}
        {tab === "inactivity" && <InactivitySettingsView />}
      </div>
    </div>
  );
}

// ---------- General ----------

function GeneralSettingsView() {
  const { status } = usePortly();
  const [prefs, setPrefs] = usePrefs();
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [loginItemError, setLoginItemError] = useState<string | null>(null);

  useEffect(() => {
    native.getAutostart().then(setLaunchAtLogin).catch(() => {});
  }, []);

  // AppPresentation.load(): repair a state where both surfaces are hidden.
  useEffect(() => {
    if (!prefs.showInTray && !prefs.showInTaskbar) void setPrefs({ showInTray: true }).catch(() => {});
  }, [prefs.showInTray, prefs.showInTaskbar, setPrefs]);

  // AppPresentation.setShowMenuBar / setShowInDock: one of them always stays on.
  const setShowInTray = (value: boolean) => {
    void setPrefs({ showInTray: value, showInTaskbar: !value && !prefs.showInTaskbar ? true : prefs.showInTaskbar }).catch(() => {});
  };
  const setShowInTaskbar = (value: boolean) => {
    void setPrefs({ showInTaskbar: value, showInTray: !value && !prefs.showInTray ? true : prefs.showInTray }).catch(() => {});
  };

  const updateLaunchAtLogin = async (enabled: boolean) => {
    setLaunchAtLogin(enabled);
    try {
      await native.setAutostart(enabled);
      setLaunchAtLogin(await native.getAutostart());
    } catch (e) {
      setLaunchAtLogin(await native.getAutostart().catch(() => !enabled));
      setLoginItemError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Form>
      <Section header="System tray">
        <div className="form-row pf-toggle-row">
          <Toggle label="Show Portly in the system tray" checked={prefs.showInTray} onChange={setShowInTray} />
        </div>
        <div className={`form-row${prefs.showInTray ? "" : " st-disabled"}`}>
          <div className="form-row-label">Appearance</div>
          <div className="form-row-control">
            <Picker<string>
              style="segmented"
              disabled={!prefs.showInTray}
              value={prefs.showTrayName ? "name" : "icon"}
              onChange={(v) => void setPrefs({ showTrayName: v === "name" }).catch(() => {})}
              options={[{ value: "icon", label: "Icon only" }, { value: "name", label: "Icon and name" }]}
            />
          </div>
        </div>
        <TextRow caption>Drag Portly to reposition it in the system tray.</TextRow>
      </Section>

      <Section header="Taskbar">
        <div className="form-row pf-toggle-row">
          <Toggle label="Show Portly in the taskbar" checked={prefs.showInTaskbar} onChange={setShowInTaskbar} />
        </div>
        <TextRow caption>When hidden, Portly stays in the system tray and keeps supervising servers.</TextRow>
      </Section>

      <Section header="Startup">
        <div className="form-row pf-toggle-row">
          <Toggle label="Launch Portly at login" checked={launchAtLogin} onChange={(v) => void updateLaunchAtLogin(v)} />
        </div>
        <TextRow caption>Closing the main window keeps Portly and its managed servers running.</TextRow>
      </Section>

      <Section header="Configuration">
        <Row label="Config file">
          <span className="mono secondary selectable" style={{ fontSize: 11 }}>%APPDATA%\Portly\config.json</span>
        </Row>
        <div className="form-row">
          <Button onClick={() => void native.revealConfig()}>Reveal Config File</Button>
        </div>
      </Section>

      <Section header="Portly">
        <Row label="Version">
          <span className="secondary">{status?.version ?? "—"}</span>
        </Row>
        <div className="form-row">
          <Button onClick={() => {
            void setPrefs({ agentOnboardingDismissed: false }).catch(() => {});
            void native.openMain();
          }}>Show Agent Setup</Button>
        </div>
      </Section>

      <Alert
        open={loginItemError != null}
        title="Unable to update login setting"
        message={loginItemError ?? "The login setting could not be changed."}
        actions={[{ label: "OK", role: "default", onClick: () => setLoginItemError(null) }]}
      />
    </Form>
  );
}

// ---------- Servers ----------

function RuntimeSettingsView() {
  const { config } = usePortly();
  const [healthIntervalSeconds, setHealthIntervalSeconds] = useState(10);
  const [maxRestartAttempts, setMaxRestartAttempts] = useState(5);
  const [logBufferLines, setLogBufferLines] = useState(5000);
  const [logFileMaxMB, setLogFileMaxMB] = useState(10);
  const [saved, setSaved] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current || !config) return;
    loaded.current = true;
    setHealthIntervalSeconds(config.healthIntervalSeconds);
    setMaxRestartAttempts(config.maxRestartAttempts);
    setLogBufferLines(config.logBufferLines);
    setLogFileMaxMB(config.logFileMaxMB);
  }, [config]);

  const change = <V,>(set: (v: V) => void) => (v: V) => { set(v); setSaved(false); };

  const hasChanges = config != null && (
    healthIntervalSeconds !== config.healthIntervalSeconds
    || maxRestartAttempts !== config.maxRestartAttempts
    || logBufferLines !== config.logBufferLines
    || logFileMaxMB !== config.logFileMaxMB
  );

  const save = useCallback(async () => {
    if (!hasChanges) return;
    try {
      await act(() => api.updateSettings({ healthIntervalSeconds, maxRestartAttempts, logBufferLines, logFileMaxMB }));
      setSaved(true);
    } catch {
      setSaved(false);
    }
  }, [hasChanges, healthIntervalSeconds, maxRestartAttempts, logBufferLines, logFileMaxMB]);

  // .keyboardShortcut(.defaultAction)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Enter") void save(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  return (
    <Form>
      <Section header="Health checks">
        <Row label={`Check every ${healthIntervalSeconds} seconds`}>
          <Stepper value={healthIntervalSeconds} onChange={change(setHealthIntervalSeconds)} min={2} max={120} />
        </Row>
        <Row label={`Stop after ${maxRestartAttempts} failed restart ${maxRestartAttempts === 1 ? "attempt" : "attempts"}`}>
          <Stepper value={maxRestartAttempts} onChange={change(setMaxRestartAttempts)} min={1} max={20} />
        </Row>
        <TextRow caption>Portly restarts unhealthy servers only when automatic restart is enabled for that server.</TextRow>
      </Section>

      <Section header="Logs">
        <Row label={`Keep ${logBufferLines.toLocaleString("en-US")} lines per server`}>
          <Stepper value={logBufferLines} onChange={change(setLogBufferLines)} min={500} max={50000} step={500} />
        </Row>
        <Row label={`Rotate log files after ${logFileMaxMB} MB`}>
          <Stepper value={logFileMaxMB} onChange={change(setLogFileMaxMB)} min={1} max={100} />
        </Row>
      </Section>

      <Section>
        <div className="form-row">
          {saved && (
            <span className="st-saved">
              <Symbol name="checkmark.circle.fill" size={10} />
              Saved
            </span>
          )}
          <span style={{ flex: 1 }} />
          <Button variant="prominent" disabled={!hasChanges} onClick={() => void save()}>Save Settings</Button>
        </div>
      </Section>
    </Form>
  );
}

// ---------- Inactivity ----------

const INHERIT = -1;

function InactivitySettingsView() {
  const { config, status } = usePortly();
  const projects = config?.projects ?? [];
  const global = config?.idleTimeoutSeconds ?? null;
  const runtimes = new Map<string, ServerStatus>((status?.projects ?? []).flatMap((p) => p.servers).map((s) => [s.id, s]));

  const setGlobal = (seconds: number) => void act(() => api.idleTimeout({ seconds })).catch(() => {});
  const setServer = (server: ServerConfig, seconds: number | null) =>
    void act(() => api.idleTimeout({ server: server.id, seconds })).catch(() => {});

  const idleDetail = (server: ServerConfig): string | null => {
    const rt = runtimes.get(server.id);
    if (!rt) return null;
    const running = isActiveState(rt.state);
    if (running && rt.idleTimeoutSeconds != null && rt.lastActivityAt) {
      const quiet = Math.max(0, Math.floor((Date.now() - new Date(rt.lastActivityAt).getTime()) / 1000));
      return `Running · quiet ${Math.floor(quiet / 60)}m of ${Math.floor(rt.idleTimeoutSeconds / 60)}m`;
    }
    if (running) return "Running";
    if (rt.idleStoppedAt) return `Stopped for inactivity at ${shortTime(new Date(rt.idleStoppedAt))}`;
    return null;
  };

  return (
    <Form>
      <Section>
        <div className="form-row st-intro">
          <div className="st-intro-stack">
            <span className="st-intro-title" style={T.bodyMedium}><Symbol name="moon.zzz" size={13} />Automatic idle stop</span>
            <span className="pf-caption">
              A server is idle when it prints nothing and stays under {BUSY_CPU_PERCENT}% CPU. Output answering Portly's own health checks does not count. Idle servers are stopped, not restarted. Turn it off for databases, queues, and quiet workers.
            </span>
          </div>
        </div>
      </Section>

      <Section header="Global default">
        <Row label="Stop idle servers after">
          <Picker
            value={global ?? 0}
            onChange={setGlobal}
            options={[{ value: 0, label: "Never" }, ...idleChoices(global).map((s) => ({ value: s, label: describeIdle(s) }))]}
          />
        </Row>
      </Section>

      {projects.length === 0 ? (
        <Section header="Servers">
          <TextRow color="var(--secondary-label)">No projects configured.</TextRow>
        </Section>
      ) : (
        projects.map((project) => (
          <Section
            key={project.id}
            header={
              <span className="st-project-header">
                <span className="st-dot" style={{ width: 8, height: 8, background: hexColor(project.color) }} />
                {project.name}
              </span>
            }
          >
            {project.servers.map((server) => {
              const detail = idleDetail(server);
              return (
                <div key={server.id} className="form-row st-idle-row">
                  <div className="st-idle-text">
                    <span style={T.bodyMedium}>{server.name}</span>
                    {detail && <span className="secondary digits" style={T.metadata}>{detail}</span>}
                  </div>
                  <span style={{ flex: 1 }} />
                  <span aria-label={`Idle stop for ${server.name}`}>
                    <Picker
                      value={server.idleTimeoutSeconds ?? INHERIT}
                      onChange={(v) => setServer(server, v === INHERIT ? null : v)}
                      options={[
                        { value: INHERIT, label: `Global (${global != null && global > 0 ? describeIdle(global) : "never"})` },
                        { value: 0, label: "Never" },
                        ...idleChoices(server.idleTimeoutSeconds).map((s) => ({ value: s, label: describeIdle(s) })),
                      ]}
                    />
                  </span>
                </div>
              );
            })}
          </Section>
        ))
      )}
    </Form>
  );
}

// ---------- Memory ----------

type EditorTarget = { kind: "global" } | { kind: "project"; project: Project };

function MemoryGuardSettingsView() {
  const { config, status } = usePortly();
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const projects = config?.projects ?? [];
  const global = config?.globalMemoryLimitBytes ?? null;

  const save = async (target: EditorTarget, mode: MemoryLimitMode, bytes: number | null) => {
    if (target.kind === "global") {
      await act(() => api.memoryLimit({ mode: mode === "custom" ? "custom" : "disabled", bytes: mode === "custom" ? bytes : null }));
    } else {
      await act(() => api.memoryLimit({ project: target.project.id, mode, bytes }));
    }
  };

  return (
    <>
      <Form>
        <Section>
          <div className="form-row st-intro">
            <div className="st-intro-stack">
              <span className="st-intro-title" style={T.bodyMedium}><Symbol name="shield.lefthalf.filled" size={13} />Automatic memory guard</span>
              <span className="pf-caption">
                Portly measures each project's total footprint every two seconds. Three consecutive samples above its limit restart every running server in that project, then sampling starts fresh on the new processes.
              </span>
            </div>
          </div>
        </Section>

        <Section header="Global default">
          <div className="form-row st-global-row">
            <span className="st-global-icon"><Symbol name="globe" size={15} strokeWidth={2.4} /></span>
            <div className="st-stack-2">
              <span style={T.bodyMedium}>{global != null ? displayMemory(global) : "Off"}</span>
              <span className="secondary" style={T.metadata}>
                {global == null
                  ? "Memory restarts are off for projects using the global default"
                  : "Applied separately to every project using the global default"}
              </span>
            </div>
            <span style={{ flex: 1 }} />
            <Button aria-label="Edit global memory limit" onClick={() => setEditing({ kind: "global" })}>Edit…</Button>
          </div>
        </Section>

        <Section header="Projects">
          {projects.length === 0 ? (
            <TextRow color="var(--secondary-label)">No projects configured.</TextRow>
          ) : (
            projects.map((project) => {
              const ps = status?.projects.find((p) => p.id === project.id);
              return (
                <ProjectMemoryRow
                  key={project.id}
                  project={project}
                  global={global}
                  footprint={ps?.servers.reduce((sum, s) => sum + (s.memoryBytes ?? 0), 0) ?? 0}
                  lastRestartAt={ps?.lastMemoryRestartAt ?? null}
                  onEdit={() => setEditing({ kind: "project", project })}
                />
              );
            })
          )}
        </Section>
      </Form>

      <Sheet open={editing != null} onClose={() => setEditing(null)} width={500}>
        {editing && (
          <MemoryLimitEditor
            key={editing.kind === "global" ? "global" : editing.project.id}
            target={editing}
            globalLimitBytes={global}
            onCancel={() => setEditing(null)}
            onSave={async (mode, bytes) => {
              await save(editing, mode, bytes);
              setEditing(null);
            }}
          />
        )}
      </Sheet>
    </>
  );
}

function ProjectMemoryRow({ project, global, footprint, lastRestartAt, onEdit }: {
  project: Project; global: number | null; footprint: number; lastRestartAt: string | null; onEdit: () => void;
}) {
  const limit = project.memoryLimitMode === "inherit" ? global : project.memoryLimitMode === "custom" ? project.memoryLimitBytes : null;
  const ratio = limit != null ? Math.min(footprint / Math.max(limit, 1), 1) : 0;
  const color = limit == null ? "var(--secondary-label)" : ratio >= 0.8 ? "var(--sys-orange)" : "var(--sys-green)";
  const policy = { inherit: "GLOBAL", custom: "CUSTOM", disabled: "OFF" }[project.memoryLimitMode];

  return (
    <div className="form-row st-memory-row">
      <span className="st-dot" style={{ width: 9, height: 9, background: hexColor(project.color) }} />
      <div className="st-memory-stack">
        <div className="st-memory-title">
          <span style={T.bodyMedium}>{project.name}</span>
          <span className="st-pill" style={{ ...T.label, color, background: `color-mix(in srgb, ${color} 10%, transparent)` }}>{policy}</span>
        </div>
        {limit != null ? (
          <>
            <div className="st-progress" role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${ratio * 100}%`, background: color }} />
            </div>
            <span className="secondary digits" style={T.metadata}>{displayMemory(footprint)} of {displayMemory(limit)}</span>
          </>
        ) : (
          <span className="secondary" style={T.metadata}>Automatic restart disabled</span>
        )}
        {lastRestartAt && (
          <span className="st-last-restart" style={T.metadata}>
            <Symbol name="arrow.clockwise" size={10} />
            Last automatic restart: {abbreviatedDateTime(new Date(lastRestartAt))}
          </span>
        )}
      </div>
      <span style={{ flex: 1 }} />
      <Button aria-label={`Edit memory limit for ${project.name}`} onClick={onEdit}>Edit…</Button>
    </div>
  );
}

function MemoryLimitEditor({ target, globalLimitBytes, onCancel, onSave }: {
  target: EditorTarget; globalLimitBytes: number | null; onCancel: () => void; onSave: (mode: MemoryLimitMode, bytes: number | null) => Promise<void>;
}) {
  const initialMode: MemoryLimitMode = target.kind === "global" ? (globalLimitBytes == null ? "disabled" : "custom") : target.project.memoryLimitMode;
  const initialBytes = target.kind === "global" ? globalLimitBytes : target.project.memoryLimitBytes ?? globalLimitBytes;
  const [mode, setMode] = useState<MemoryLimitMode>(initialMode);
  const [value, setValue] = useState(initialBytes != null ? displayMemory(initialBytes).replace(/ /g, "") : "5GB");
  const [showValidationError, setShowValidationError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  const parsedValue = parseMemorySize(value);
  const title = target.kind === "global" ? "Global memory guard" : `Memory guard · ${target.project.name}`;
  const validationMessage = showValidationError && parsedValue == null
    ? "Enter a size of at least 64 MB, for example 5GB."
    : "Examples: 512MB, 5GB, or 5Go. Minimum: 64 MB.";

  let explanation: string;
  if (target.kind === "global") {
    explanation = "The global value is a default applied separately to every project that inherits it. It is not a combined limit for the whole machine.";
  } else if (mode === "inherit") {
    explanation = globalLimitBytes != null
      ? `This project currently inherits ${displayMemory(globalLimitBytes)} from the global setting.`
      : "The global guard is off, so inheritance currently leaves this project unprotected.";
  } else {
    explanation = "This policy applies only to this project and overrides the global setting.";
  }

  const options: { value: MemoryLimitMode; label: string }[] = [
    ...(target.kind === "project" ? [{ value: "inherit" as const, label: "Inherit global limit" }] : []),
    { value: "disabled", label: "Disabled" },
    { value: "custom", label: "Custom limit" },
  ];

  const save = async () => {
    if (mode === "custom" && parsedValue == null) {
      setShowValidationError(true);
      valueRef.current?.focus();
      return;
    }
    try {
      await onSave(mode, mode === "custom" ? parsedValue : null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div
      className="st-editor"
      onKeyDown={(e) => { if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); void save(); } }}
    >
      <div className="st-editor-header">
        <span style={T.title}>{title}</span>
        <span className="secondary" style={T.metadata}>Automatic restart policy</span>
      </div>
      <Divider />
      <Form style={{ flex: 1, background: "var(--window-bg)" }}>
        <Section>
          <div className="form-row st-radio-row">
            <div className="form-row-label">Policy</div>
            <div className="st-radios" role="radiogroup" aria-label="Policy">
              {options.map((o) => (
                <label key={o.value} className="st-radio" onClick={(e) => { e.preventDefault(); setMode(o.value); }}>
                  <span className={`st-radio-dot${mode === o.value ? " on" : ""}`} role="radio" aria-checked={mode === o.value} />
                  {o.label}
                </label>
              ))}
            </div>
          </div>
          {mode === "custom" && (
            <>
              <FieldRow label="Limit" value={value} onChange={setValue} inputRef={valueRef} autoFocus />
              <TextRow style={{ ...T.metadata, color: showValidationError && parsedValue == null ? "var(--sys-red)" : "var(--secondary-label)" }}>
                {validationMessage}
              </TextRow>
            </>
          )}
        </Section>

        <Section header="How it works">
          <TextRow style={{ ...T.body, color: "var(--secondary-label)" }}>{explanation}</TextRow>
          <LabelRow icon="clock.arrow.2.circlepath" style={T.metadata}>Three consecutive samples above the limit</LabelRow>
          <LabelRow icon="arrow.counterclockwise" style={T.metadata}>Sampling resets after each restart</LabelRow>
          <LabelRow icon="arrow.triangle.2.circlepath" style={T.metadata}>All running servers in an affected project restart together</LabelRow>
        </Section>
      </Form>
      <Divider />
      <div className="pf-buttons">
        {error && <span className="pf-error">{error}</span>}
        <span style={{ flex: 1 }} />
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="prominent" onClick={() => void save()}>Save</Button>
      </div>
    </div>
  );
}

// ---------- Date formatting (Date.formatted) ----------

/** .formatted(date: .omitted, time: .shortened) → "3:41 PM" */
function shortTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** .formatted(date: .abbreviated, time: .shortened) → "Oct 12, 2026 at 3:41 PM" */
function abbreviatedDateTime(d: Date): string {
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${date} at ${shortTime(d)}`;
}
