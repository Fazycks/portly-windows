// Port of Forms.swift: ProjectForm (+ IconColorPicker), ServerForm (+ SuggestionRow)
// and TemporaryProcessForm. Each renders the whole sheet body; the caller wraps it
// in <Sheet>. The grouped-form row helpers exported here (FieldRow, TextRow, …) are
// the macOS `Form(.grouped)` renderings of TextField / Text / Label rows and are
// reused by SettingsView.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { api, type DetectedCommand, type MemoryLimitMode, type Project, type ServerAction, type ServerConfig } from "../lib/api";
import { act, usePortly } from "../lib/store";
import { pickFolder } from "../lib/native";
import { PROJECT_ICONS, Symbol } from "../lib/symbols";
import { Button, Divider, Form, Picker, ProgressSpinner, Row, Section, T, Toggle, hexColor } from "../components/ui";
import "./Forms.css";

// ---------- PortlyCore helpers (Models.swift / Supervisor.swift) ----------

/** Supervisor.palette — handed out in this order. */
export const PALETTE = ["#0A84FF", "#FF9F0A", "#BF5AF2", "#30D158", "#FF375F", "#64D2FF", "#FFD60A", "#5E5CE6", "#66D4CF", "#8E8E93"];
export const PALETTE_NAMES = ["Blue", "Orange", "Purple", "Green", "Pink", "Cyan", "Yellow", "Indigo", "Mint", "Gray"];
const DEFAULT_ICON = "shippingbox.fill";
/** IdleTracker.busyCPUPercent */
export const BUSY_CPU_PERCENT = 5;

/** Supervisor.nextColor(excluding:) */
export function nextColor(used: string[]): string {
  const counts = new Map<string, number>();
  for (const hex of used) counts.set(hex.toUpperCase(), (counts.get(hex.toUpperCase()) ?? 0) + 1);
  let best = PALETTE[0];
  let bestCount = Infinity;
  for (const hex of PALETTE) {
    const count = counts.get(hex.toUpperCase()) ?? 0;
    if (!(count < bestCount)) continue;
    best = hex;
    bestCount = count;
    if (count === 0) break;
  }
  return best;
}

/** IdleTimeout.presets / describe */
export const IDLE_PRESETS = [15 * 60, 30 * 60, 60 * 60, 2 * 3600, 4 * 3600];
export function describeIdle(seconds: number): string {
  const plural = (v: number, unit: string) => `${v} ${unit}${v === 1 ? "" : "s"}`;
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}
/** Keeps a custom value selectable instead of snapping it to a preset. */
export function idleChoices(current: number | null | undefined): number[] {
  const extra = current != null && current > 0 ? [current] : [];
  return Array.from(new Set([...IDLE_PRESETS, ...extra])).sort((a, b) => a - b);
}

/** MemorySize.parse */
export function parseMemorySize(raw: string): number | null {
  const normalized = raw.trim().toLowerCase().replace(/,/g, ".").replace(/ /g, "");
  if (!normalized) return null;
  const units: [string, number][] = [
    ["tib", 1_099_511_627_776], ["tb", 1_099_511_627_776], ["to", 1_099_511_627_776],
    ["gib", 1_073_741_824], ["gb", 1_073_741_824], ["go", 1_073_741_824],
    ["mib", 1_048_576], ["mb", 1_048_576], ["mo", 1_048_576],
  ];
  const unit = units.find(([s]) => normalized.endsWith(s));
  if (!unit) return null;
  const number = normalized.slice(0, normalized.length - unit[0].length);
  if (!/^[+]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(number)) return null;
  const amount = Number(number);
  if (!(amount > 0)) return null;
  const bytes = amount * unit[1];
  if (!isFinite(bytes) || bytes < 128 * 1_048_576 || bytes > 1_099_511_627_776) return null;
  return Math.round(bytes);
}

/** MemorySize.display: "5 GB", "1.5 GB", "512 MB". */
export function displayMemory(bytes: number): string {
  const gib = 1_073_741_824;
  if (bytes >= gib) {
    const value = bytes / gib;
    const digits = Math.round(value) === value ? 0 : 1;
    return `${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} GB`;
  }
  return `${Math.floor(bytes / 1_048_576)} MB`;
}

/** TemporaryTimeout.parse */
export function parseTimeout(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  let multiplier = 1;
  let number = value;
  const last = value[value.length - 1];
  if (last === "s") { multiplier = 1; number = value.slice(0, -1); }
  else if (last === "m") { multiplier = 60; number = value.slice(0, -1); }
  else if (last === "h") { multiplier = 3600; number = value.slice(0, -1); }
  if (!/^[+]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(number)) return null;
  const amount = Number(number);
  if (!(amount > 0)) return null;
  const seconds = Math.ceil(amount * multiplier);
  if (seconds > 7 * 24 * 60 * 60) return null;
  return seconds;
}

/** Swift `Int(String)`: optional sign and digits only. */
const parseInt32 = (s: string): number | null => (/^[+-]?\d+$/.test(s) ? Number(s) : null);

// ---------- Grouped-form row helpers ----------

/** A titled TextField in a grouped Form: label leading, borderless field filling the row. */
export function FieldRow({
  label, value, onChange, mono, align = "left", help, inputRef, bordered, multiline, minRows = 1, maxRows = 1, trailing, autoFocus,
}: {
  label: string; value: string; onChange: (v: string) => void; mono?: boolean; align?: "left" | "right"; help?: string;
  inputRef?: RefObject<HTMLInputElement | null>; bordered?: boolean; multiline?: boolean; minRows?: number; maxRows?: number;
  trailing?: ReactNode; autoFocus?: boolean;
}) {
  const cls = `pf-input${mono ? " mono" : ""}${bordered ? " bordered" : ""}`;
  const rows = Math.min(maxRows, Math.max(minRows, value.split("\n").length));
  return (
    <div className={`form-row pf-field-row${multiline ? " multiline" : ""}`} title={help}>
      <span className="pf-field-label">{label}</span>
      {multiline ? (
        <textarea className={cls} value={value} rows={rows} spellCheck={false} aria-label={label} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          ref={inputRef}
          className={cls}
          style={{ textAlign: align }}
          value={value}
          spellCheck={false}
          autoFocus={autoFocus}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {trailing}
    </div>
  );
}

/** A bare `Text` inside a Form section. `caption` = `.font(.caption).foregroundStyle(.secondary)`. */
export function TextRow({ children, caption, color, style }: { children: ReactNode; caption?: boolean; color?: string; style?: React.CSSProperties }) {
  return (
    <div className="form-row">
      <span className={caption ? "pf-caption" : undefined} style={{ color, ...style }}>{children}</span>
    </div>
  );
}

/** `Label { … } icon: { … }` row. */
export function LabelRow({ icon, iconColor, children, style }: { icon: string; iconColor?: string; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="form-row pf-label-row" style={style}>
      <span className="pf-label-icon" style={{ color: iconColor }}><Symbol name={icon} size={13} /></span>
      <div className="pf-label-text">{children}</div>
    </div>
  );
}

/** The sheet chrome every form shares: grouped Form, Divider, button bar with `.padding(14)`. */
function FormSheet({ width, children, footer, onDefault }: { width: number; children: ReactNode; footer: ReactNode; onDefault?: () => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // .keyboardShortcut(.defaultAction): Return triggers the primary button (not inside multi-line fields).
    if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      onDefault?.();
    }
  };
  return (
    <div className="pf-sheet" style={{ width }} onKeyDown={onKeyDown}>
      <Form>{children}</Form>
      <Divider />
      <div className="pf-buttons">{footer}</div>
    </div>
  );
}

const Spacer = () => <span style={{ flex: 1 }} />;

// ---------- ProjectForm ----------

export function ProjectForm({ project, takenColors, onDone }: { project: Project | null; takenColors: string[]; onDone: (projectId?: string) => void }) {
  const [name, setName] = useState(project?.name ?? "");
  const [root, setRoot] = useState(project?.root ?? "");
  const [icon, setIcon] = useState(project?.icon ?? DEFAULT_ICON);
  const [color, setColor] = useState(() => project?.color ?? nextColor(takenColors));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim() !== "" && root !== "" && !busy;

  const chooseFolder = async () => {
    const path = await pickFolder("Choose a folder", root || undefined);
    if (!path) return;
    setRoot(path);
    if (name === "") setName(path.split(/[\\/]/).filter(Boolean).pop() ?? "");
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = name.trim();
      if (project == null) {
        const added = await act(() => api.addProject({ name: trimmed, root, icon, color }));
        onDone(added.id);
      } else {
        await act(() => api.updateProject({ project: project.id, name: trimmed, root, icon, color }));
        onDone(project.id);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <FormSheet
      width={480}
      onDefault={save}
      footer={
        <>
          {error && <span className="pf-error">{error}</span>}
          <Spacer />
          <Button onClick={() => onDone()}>Cancel</Button>
          <Button variant="prominent" disabled={!canSave} onClick={save}>{project == null ? "Add Project" : "Save"}</Button>
        </>
      }
    >
      <Section>
        <FieldRow label="Name" value={name} onChange={setName} autoFocus />
        <FieldRow label="Folder" value={root} onChange={setRoot} mono trailing={<Button onClick={chooseFolder}>Choose…</Button>} />
      </Section>
      <Section header="Appearance">
        <div className="form-row">
          <IconColorPicker icon={icon} color={color} takenColors={takenColors} onIcon={setIcon} onColor={setColor} />
        </div>
      </Section>
    </FormSheet>
  );
}

/** A grid of colors and a grid of symbols, drawn as they will look in the sidebar. */
function IconColorPicker({ icon, color, takenColors, onIcon, onColor }: {
  icon: string; color: string; takenColors: string[]; onIcon: (v: string) => void; onColor: (v: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const taken = useMemo(() => {
    const s = new Set(takenColors.map((c) => c.toUpperCase()));
    s.delete(color.toUpperCase());
    return s;
  }, [takenColors, color]);
  const c = hexColor(color);

  const symbolBackground = (symbol: string) => {
    if (icon === symbol) return `color-mix(in srgb, ${c} 14%, transparent)`;
    if (hovered === symbol) return "rgba(var(--pf-primary), 0.07)";
    return "transparent";
  };

  return (
    <div className="icp">
      <div
        className="icp-preview"
        aria-label="Project icon preview"
        style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${c} 28%, transparent)`, color: c }}
      >
        <Symbol name={icon} size={24} strokeWidth={2.2} />
      </div>
      <div className="icp-groups">
        <div className="icp-group">
          <span className="pf-caption">Color</span>
          <div className="icp-colors">
            {PALETTE.map((hex, index) => {
              const name = PALETTE_NAMES[index];
              const isTaken = taken.has(hex.toUpperCase());
              const selected = color === hex;
              return (
                <button
                  key={hex}
                  className="icp-color"
                  aria-label={name}
                  title={isTaken ? `${name}, already used by another project` : name}
                  style={{ boxShadow: selected ? "inset 0 0 0 2px rgba(var(--pf-primary), 0.7)" : undefined }}
                  onClick={() => onColor(hex)}
                >
                  <span style={{ background: hexColor(hex), opacity: isTaken ? 0.3 : 1 }} />
                </button>
              );
            })}
          </div>
        </div>
        <div className="icp-group">
          <span className="pf-caption">Symbol</span>
          <div className="icp-symbols">
            {PROJECT_ICONS.map((symbol) => {
              const selected = icon === symbol;
              return (
                <button
                  key={symbol}
                  className="icp-symbol"
                  aria-label={symbol.replace(/\./g, " ")}
                  title={symbol}
                  style={{
                    color: selected ? c : "var(--secondary-label)",
                    background: symbolBackground(symbol),
                    boxShadow: selected ? `inset 0 0 0 1px color-mix(in srgb, ${c} 32%, transparent)` : undefined,
                  }}
                  onMouseEnter={() => setHovered(symbol)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => onIcon(symbol)}
                >
                  <Symbol name={symbol} size={14} strokeWidth={selected ? 2.25 : 2} />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- ServerForm ----------

type Suggestion = DetectedCommand & { id: string };
const INHERIT = -1; // Int?.none in the idle picker

export function ServerForm({ server, projectID, projectName, projectRoot, onDone }: {
  server: ServerConfig | null; projectID: string; projectName: string; projectRoot: string; onDone: (serverId?: string) => void;
}) {
  const { config } = usePortly();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [portText, setPortText] = useState("");
  const [directory, setDirectory] = useState("");
  const [healthURL, setHealthURL] = useState("");
  const [autoRestart, setAutoRestart] = useState(true);
  const [idleTimeoutSeconds, setIdleTimeoutSeconds] = useState<number | null>(null);
  const [envText, setEnvText] = useState("");
  const [actionsText, setActionsText] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [setupMode, setSetupMode] = useState<"automatic" | "manual">("automatic");
  const [isDetecting, setIsDetecting] = useState(true);
  const [selectedSuggestionID, setSelectedSuggestionID] = useState<string | null>(null);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [memoryLimitMode, setMemoryLimitMode] = useState<MemoryLimitMode>("inherit");
  const [memoryLimit, setMemoryLimit] = useState("5GB");
  const [showMemoryLimitError, setShowMemoryLimitError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memoryLimitRef = useRef<HTMLInputElement>(null);

  // load(): server fields + detection (new servers only).
  useEffect(() => {
    let cancelled = false;
    if (server == null) {
      api.nextPort(3000).then((r) => { if (!cancelled) setPortText((p) => (p === "" ? String(r.port) : p)); }).catch(() => {});
      api.detect(projectRoot)
        .then((found) => { if (!cancelled) setSuggestions(found.map((s, i) => ({ ...s, id: `${i}:${s.directory ?? ""}:${s.command}` }))); })
        .catch(() => { if (!cancelled) setSuggestions([]); })
        .finally(() => { if (!cancelled) setIsDetecting(false); });
    } else {
      setSetupMode("manual");
      setIsDetecting(false);
      const env = Object.entries(server.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
      const acts = (server.actions ?? []).map((a) => `${a.name}=${a.command}`).join("\n");
      setName(server.name);
      setCommand(server.command);
      setPortText(server.port != null ? String(server.port) : "");
      setDirectory(server.directory ?? "");
      setHealthURL(server.healthURL ?? "");
      setAutoRestart(server.autoRestart);
      setIdleTimeoutSeconds(server.idleTimeoutSeconds ?? null);
      setEnvText(env);
      setActionsText(acts);
      setAdvancedExpanded(!(!server.directory && !server.healthURL && env === "" && acts === ""));
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Project memory policy, once the config is available.
  const memoryLoaded = useRef(false);
  useEffect(() => {
    if (memoryLoaded.current || !config) return;
    memoryLoaded.current = true;
    const project = config.projects.find((p) => p.id === projectID);
    if (!project) return;
    setMemoryLimitMode(project.memoryLimitMode);
    const bytes = project.memoryLimitBytes ?? config.globalMemoryLimitBytes ?? null;
    if (bytes != null) setMemoryLimit(displayMemory(bytes).replace(/ /g, ""));
  }, [config, projectID]);

  const showsAutomaticSetup = server == null && setupMode === "automatic";

  const parsedActions = useMemo((): ServerAction[] | null => {
    const seen = new Set<string>();
    const actions: ServerAction[] = [];
    for (const line of actionsText.split("\n")) {
      if (line === "") continue;
      const idx = line.indexOf("=");
      if (idx <= 0 || idx === line.length - 1) return null;
      const n = line.slice(0, idx).trim();
      const c = line.slice(idx + 1).trim();
      if (!n || !c || seen.has(n.toLowerCase())) return null;
      seen.add(n.toLowerCase());
      actions.push({ name: n, command: c });
    }
    return actions;
  }, [actionsText]);

  const parsedMemoryLimit = parseMemorySize(memoryLimit);
  const hasRequiredFields = name.trim() !== "" && command.trim() !== "";
  const canSave = !busy && (showsAutomaticSetup
    ? selectedSuggestionID != null && hasRequiredFields && parsedActions != null
    : hasRequiredFields && parsedActions != null);

  const portNumber = parseInt32(portText.trim());
  const portHelpText = portNumber != null
    ? `Portly will open http://localhost:${portNumber} and use this port for health checks.`
    : "Leave the port empty only when this command does not start a local server.";

  const memoryLimitMessage = showMemoryLimitError && parsedMemoryLimit == null
    ? "Enter a size of at least 64 MB, for example 5GB."
    : "Examples: 512MB, 5GB, or 5Go. Minimum: 64 MB.";

  const globalIdle = config?.idleTimeoutSeconds ?? null;
  const globalIdleTimeoutLabel = `Use global default (${globalIdle != null && globalIdle > 0 ? describeIdle(globalIdle) : "never"})`;
  const globalMemory = config?.globalMemoryLimitBytes ?? null;
  const globalMemoryLimitMessage = globalMemory != null
    ? `The current global default is ${displayMemory(globalMemory)}.`
    : "The global default is off, so automatic memory restarts are currently disabled.";

  const apply = (s: Suggestion) => {
    setSelectedSuggestionID(s.id);
    setName(s.name);
    setCommand(s.command);
    setPortText(s.port != null ? String(s.port) : "");
    setDirectory(s.directory ?? "");
  };

  const save = async () => {
    if (!canSave) return;
    if (memoryLimitMode === "custom" && parsedMemoryLimit == null) {
      setShowMemoryLimitError(true);
      memoryLimitRef.current?.focus();
      return;
    }
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      if (line === "") continue;
      const idx = line.indexOf("=");
      if (idx <= 0 || idx === line.length - 1) continue;
      env[line.slice(0, idx).trim()] = line.slice(idx + 1);
    }
    const fields = {
      name: name.trim(),
      command: command.trim(),
      port: parseInt32(portText.trim()),
      directory: directory === "" ? null : directory,
      env,
      healthURL: healthURL === "" ? null : healthURL,
      healthStatus: server?.healthStatus ?? null,
      autoRestart,
      actions: parsedActions ?? [],
    };
    setBusy(true);
    setError(null);
    try {
      let id: string;
      await act(() => api.memoryLimit({ project: projectID, mode: memoryLimitMode, bytes: memoryLimitMode === "custom" ? parsedMemoryLimit : null }));
      if (server != null) {
        // The daemon treats null as "unchanged"; an emptied directory / health URL is sent as "".
        await act(() => api.updateServer({
          server: server.id,
          ...fields,
          directory: fields.directory ?? (server.directory ? "" : null),
          healthURL: fields.healthURL ?? (server.healthURL ? "" : null),
        }));
        if ((server.idleTimeoutSeconds ?? null) !== idleTimeoutSeconds) {
          await act(() => api.idleTimeout({ server: server.id, seconds: idleTimeoutSeconds }));
        }
        id = server.id;
      } else {
        const added = await act(() => api.addServer({ project: projectID, ...fields, idleTimeoutSeconds, start: false }));
        id = added.id;
      }
      onDone(id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const idleOptions = [
    { value: INHERIT, label: globalIdleTimeoutLabel },
    { value: 0, label: "Never" },
    ...idleChoices(idleTimeoutSeconds).map((s) => ({ value: s, label: describeIdle(s) })),
  ];

  return (
    <FormSheet
      width={520}
      onDefault={save}
      footer={
        <>
          {server == null && (showsAutomaticSetup
            ? <Button onClick={() => setSetupMode("manual")}>Set up manually</Button>
            : suggestions.length > 0 && <Button onClick={() => setSetupMode("automatic")}>Use detected command</Button>)}
          {error && <span className="pf-error">{error}</span>}
          <Spacer />
          <Button onClick={() => onDone()}>Cancel</Button>
          <Button variant="prominent" disabled={!canSave} onClick={save}>{server == null ? "Add Server" : "Save"}</Button>
        </>
      }
    >
      {showsAutomaticSetup ? (
        isDetecting ? (
          <Section header="Finding commands">
            <div className="form-row" style={{ gap: 10, paddingTop: 15, paddingBottom: 15 }}>
              <ProgressSpinner size={14} />
              <span className="secondary">Looking through {projectName}…</span>
            </div>
          </Section>
        ) : suggestions.length === 0 ? (
          <Section header="No commands detected">
            <LabelRow icon="terminal" iconColor="var(--secondary-label)" style={{ paddingTop: 15, paddingBottom: 15 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span>Portly could not find a development command</span>
                <span className="pf-caption">You can still add one with the manual setup.</span>
              </div>
            </LabelRow>
          </Section>
        ) : (
          <Section
            header="Detected commands"
            footer={<span style={{ fontSize: 11 }}>Choose what Portly should run for {projectName}. You can edit every setting later.</span>}
          >
            {suggestions.map((s) => (
              <SuggestionRow key={s.id} suggestion={s} isSelected={selectedSuggestionID === s.id} onPick={() => apply(s)} />
            ))}
          </Section>
        )
      ) : (
        <>
          <Section
            header={server == null ? "Manual setup" : projectName}
            footer={<span style={{ fontSize: 11 }}>{portHelpText}</span>}
          >
            <FieldRow label="Name" value={name} onChange={setName} autoFocus help={'How the server shows up in the sidebar, for example "web" or "api"'} />
            <FieldRow label="Command" value={command} onChange={setCommand} mono help="Runs through a login shell, so pnpm, nvm and mise all work" />
            <FieldRow label="Port" value={portText} onChange={setPortText} align="right" />
          </Section>

          <Section header="Behavior">
            <div className="form-row pf-toggle-row">
              <Toggle label="Restart automatically when it crashes" checked={autoRestart} onChange={setAutoRestart} />
            </div>
            <div className="form-row" title={`Idle means no output and under ${BUSY_CPU_PERCENT}% CPU. Use Never for databases and quiet workers.`}>
              <div className="form-row-label">Stop when idle for</div>
              <div className="form-row-control">
                <Picker value={idleTimeoutSeconds ?? INHERIT} options={idleOptions} onChange={(v) => setIdleTimeoutSeconds(v === INHERIT ? null : v)} />
              </div>
            </div>
          </Section>

          <Section header="Project memory guard">
            <Row label="Policy">
              <Picker<MemoryLimitMode>
                value={memoryLimitMode}
                onChange={setMemoryLimitMode}
                options={[
                  { value: "inherit", label: "Use global default" },
                  { value: "disabled", label: "Turn off for this project" },
                  { value: "custom", label: "Set a custom limit" },
                ]}
              />
            </Row>
            {memoryLimitMode === "custom" ? (
              <>
                <FieldRow label="Limit" value={memoryLimit} onChange={setMemoryLimit} inputRef={memoryLimitRef} help="For example 5GB or 5Go" />
                <TextRow caption color={showMemoryLimitError && parsedMemoryLimit == null ? "var(--sys-red)" : undefined}>{memoryLimitMessage}</TextRow>
              </>
            ) : memoryLimitMode === "inherit" ? (
              <TextRow caption>{globalMemoryLimitMessage}</TextRow>
            ) : null}
            <TextRow caption>This policy applies to the total footprint of every running server in {projectName}.</TextRow>
          </Section>

          <Section>
            <button className="form-row pf-disclosure" aria-expanded={advancedExpanded} onClick={() => setAdvancedExpanded((v) => !v)}>
              <span>Advanced options</span>
              <span className={`pf-disclosure-chevron${advancedExpanded ? " open" : ""}`}><Symbol name="chevron.right" size={10} /></span>
            </button>
            {advancedExpanded && (
              <>
                <FieldRow label="Directory" value={directory} onChange={setDirectory} mono help="Relative to the project folder, or an absolute path. Empty means the project folder." />
                <FieldRow label="Health URL" value={healthURL} onChange={setHealthURL} help="A path like /api/health, or a full URL. Empty means a plain TCP check." />
                <FieldRow label="Environment" value={envText} onChange={setEnvText} mono multiline minRows={2} maxRows={4} help="One KEY=VALUE per line" />
                <FieldRow label="Actions" value={actionsText} onChange={setActionsText} mono multiline minRows={2} maxRows={5} help="One NAME=COMMAND per line, for example clear-cache=trash .next/cache" />
              </>
            )}
          </Section>
        </>
      )}
    </FormSheet>
  );
}

function SuggestionRow({ suggestion, isSelected, onPick }: { suggestion: Suggestion; isSelected: boolean; onPick: () => void }) {
  return (
    <button className="form-row pf-suggestion" aria-pressed={isSelected} onClick={onPick}>
      <span className="pf-suggestion-icon" style={{ color: isSelected ? "var(--accent)" : "var(--secondary-label)" }}>
        <Symbol name="terminal" size={12} strokeWidth={2.25} />
      </span>
      <span className="pf-suggestion-text">
        <span className="mono" style={{ fontSize: 12 }}>{suggestion.command}</span>
        <span className="pf-suggestion-meta">
          <span>{suggestion.source}</span>
          {suggestion.port != null && <span>Port {String(suggestion.port)}</span>}
        </span>
      </span>
      <Spacer />
      {isSelected ? (
        <span style={{ color: "var(--accent)", display: "inline-flex" }}><Symbol name="checkmark.circle.fill" size={15} /></span>
      ) : (
        <span className="pf-circle" aria-hidden />
      )}
    </button>
  );
}

// ---------- TemporaryProcessForm ----------

export function TemporaryProcessForm({ onDone }: { onDone: (jobId?: string) => void }) {
  const [name, setName] = useState("Temporary process");
  const [command, setCommand] = useState("");
  const [home, setHome] = useState("");
  const [directory, setDirectory] = useState("");
  const [portText, setPortText] = useState("");
  const [healthURL, setHealthURL] = useState("");
  const [timeoutText, setTimeoutText] = useState("30m");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    homeDir().then((h) => {
      const clean = h.replace(/[\\/]+$/, "");
      setHome(clean);
      setDirectory((d) => (d === "" ? clean : d));
    }).catch(() => {});
  }, []);

  const expandTilde = (p: string) => (home && (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) ? home + p.slice(1) : p);

  // The folder's existence is checked by the daemon on run (no fs access from the webview).
  const canRun = !busy
    && name.trim() !== ""
    && command.trim() !== ""
    && expandTilde(directory).trim() !== ""
    && parseTimeout(timeoutText) != null
    && (portText.trim() === "" || parseInt32(portText) != null);

  const chooseDirectory = async () => {
    const path = await pickFolder("Choose a folder", expandTilde(directory) || undefined);
    if (path) setDirectory(path);
  };

  const run = async () => {
    if (!canRun) return;
    const timeoutSeconds = parseTimeout(timeoutText);
    if (timeoutSeconds == null) { onDone(); return; }
    const health = healthURL.trim();
    // healthURL is accepted by POST /temporary/run but missing from api.runTemporary's type.
    const body: Parameters<typeof api.runTemporary>[0] & { healthURL?: string } = {
      name: name.trim(),
      command: command.trim(),
      directory: expandTilde(directory),
      port: parseInt32(portText.trim()),
      timeoutSeconds,
      ...(health ? { healthURL: health } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const job = await act(() => api.runTemporary(body));
      onDone(job.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <FormSheet
      width={540}
      onDefault={run}
      footer={
        <>
          {error && <span className="pf-error">{error}</span>}
          <Spacer />
          <Button onClick={() => onDone()}>Cancel</Button>
          <Button variant="prominent" disabled={!canRun} onClick={run}>Run Temporary</Button>
        </>
      }
    >
      <Section>
        <LabelRow icon="clock.badge" iconColor="var(--accent)" style={T.body}>
          Temporary jobs run in the background, stop their full process group at the timeout, and keep their result for one hour.
        </LabelRow>
        <TextRow style={{ ...T.metadata, color: "var(--secondary-label)" }}>For long-lived or reusable work, create a project instead.</TextRow>
      </Section>

      <Section header="Process">
        <FieldRow label="Name" value={name} onChange={setName} />
        <FieldRow label="Command" value={command} onChange={setCommand} mono multiline minRows={2} maxRows={5} />
        <FieldRow label="Working directory" value={directory} onChange={setDirectory} mono trailing={<Button onClick={chooseDirectory}>Choose…</Button>} />
      </Section>

      <Section header="Monitoring">
        <FieldRow label="Timeout (for example 30s, 10m, 2h)" value={timeoutText} onChange={setTimeoutText} bordered />
        <FieldRow label="Port" value={portText} onChange={setPortText} bordered />
        <FieldRow label="Health path or URL" value={healthURL} onChange={setHealthURL} bordered />
      </Section>
    </FormSheet>
  );
}
