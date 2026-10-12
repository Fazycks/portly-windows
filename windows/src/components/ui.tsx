// Port of UIComponents.swift + Motion.swift, plus the AppKit controls SwiftUI
// renders implicitly (push buttons, switches, pickers, grouped forms, sheets).
// Every view builds on these so spacing and colours stay identical everywhere.
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { act } from "../lib/store";
import { api, isActiveState, type ServerState, type ServerStatus } from "../lib/api";
import { Symbol } from "../lib/symbols";
import "./ui.css";

/** PortlyTypography (rounded faces map to Inter; monospaced to Cascadia/Consolas). */
export const T = {
  body: { fontSize: 13, fontWeight: 400 } as CSSProperties,
  bodyMedium: { fontSize: 13, fontWeight: 500 } as CSSProperties,
  project: { fontSize: 13, fontWeight: 600 } as CSSProperties,
  title: { fontSize: 17, fontWeight: 600 } as CSSProperties,
  label: { fontSize: 10, fontWeight: 600 } as CSSProperties,
  metadata: { fontSize: 10.5, fontWeight: 400, fontFamily: "var(--font-mono)" } as CSSProperties,
  metric: { fontSize: 12, fontWeight: 500, fontFamily: "var(--font-mono)" } as CSSProperties,
};

export const stateLabel = (s: ServerState) =>
  ({ stopped: "Stopped", starting: "Starting", running: "Running", unhealthy: "Unhealthy", restarting: "Restarting", failed: "Failed" })[s];

export const stateColor = (s: ServerState) =>
  ({
    stopped: "var(--secondary-label)",
    starting: "var(--sys-orange)",
    restarting: "var(--sys-orange)",
    running: "var(--sys-green)",
    unhealthy: "var(--sys-yellow)",
    failed: "var(--sys-red)",
  })[s];

export const isSettling = (s: ServerState) => s === "starting" || s === "restarting";

export type Pressure = "light" | "moderate" | "high";
export const pressureColor = (p: Pressure) => ({ light: "var(--sys-green)", moderate: "var(--sys-orange)", high: "var(--sys-red)" })[p];

export type Severity = "healthy" | "notice" | "warning" | "critical";
export const severityColor = (s: Severity) =>
  ({ healthy: "var(--sys-green)", notice: "var(--sys-blue)", warning: "var(--sys-orange)", critical: "var(--sys-red)" })[s];
export const severityImage = (s: Severity) =>
  ({ healthy: "checkmark.circle.fill", notice: "info.circle.fill", warning: "exclamationmark.triangle.fill", critical: "exclamationmark.octagon.fill" })[s];

/** Color(hex:) — accepts "#RGB", "#RRGGBB" or without "#". */
export function hexColor(hex: string | undefined | null): string {
  let v = (hex ?? "").replace(/[^0-9a-fA-F]/g, "");
  if (v.length === 3) v = v.split("").map((c) => c + c).join("");
  if (v.length !== 6) v = "8E8E93";
  return `#${v}`;
}

/** Date.compactUptime: "3m", "2h 14m". */
export function compactUptime(from: string | Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** ByteCountFormatter(.memory) style: "512 MB", "1.2 GB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !isFinite(bytes)) return "—";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  if (i === 0) return `${Math.round(v)} bytes`;
  const digits = i >= 3 ? (v < 10 ? 2 : 1) : 0;
  return `${v.toFixed(digits).replace(/\.0+$/, "")} ${units[i]}`;
}

/** The standard macOS status dot; breathes while a server is settling. */
export function StatusDot({ state, size = 8 }: { state: ServerState; size?: number }) {
  const c = stateColor(state);
  return (
    <span
      className={`status-dot${isSettling(state) ? " breathing" : ""}`}
      title={stateLabel(state)}
      style={{
        width: size, height: size, background: c,
        boxShadow: state === "stopped" ? "inset 0 0 0 0.5px rgba(0,0,0,0.12)" : `inset 0 0 0 0.5px rgba(0,0,0,0.12), 0 0 3px color-mix(in srgb, ${c} 34%, transparent)`,
      }}
    />
  );
}

export function StatusBadge({ state }: { state: ServerState }) {
  const c = stateColor(state);
  return (
    <span
      className="status-badge"
      style={{
        background: `color-mix(in srgb, ${c} 10%, transparent)`,
        boxShadow: `inset 0 0 0 0.75px color-mix(in srgb, ${c} 20%, transparent)`,
      }}
    >
      <StatusDot state={state} size={8} />
      <span style={T.bodyMedium}>{stateLabel(state)}</span>
    </span>
  );
}

/** One button that becomes the other (play.fill ⇄ stop.fill). Borderless, like `.buttonStyle(.borderless)`. */
export function StartStopButton({ server, symbolSize, className = "" }: { server: ServerStatus; symbolSize?: number; className?: string }) {
  const running = isActiveState(server.state);
  return (
    <button
      className={`borderless symbol-swap ${className}`}
      title={running ? "Stop" : "Start"}
      onClick={(e) => {
        e.stopPropagation();
        void act(() => (running ? api.stop({ server: server.id }) : api.start({ server: server.id })));
      }}
    >
      <Symbol key={running ? "stop" : "play"} name={running ? "stop.fill" : "play.fill"} size={symbolSize ?? 13} />
    </button>
  );
}

// ---------- AppKit-style controls ----------

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "push" | "prominent" | "borderless" | "plain" | "destructive";
  size?: "regular" | "small" | "large" | "mini";
  help?: string;
};

/** `.bordered` push button (default), `.borderedProminent` (accent), `.borderless`, `.plain`. */
export function Button({ variant = "push", size = "regular", help, className = "", children, ...rest }: BtnProps) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} title={help} {...rest}>
      {children}
    </button>
  );
}

/** SwiftUI Toggle (.switch on macOS forms, or checkbox style). */
export function Toggle({ checked, onChange, label, disabled, style = "switch" }: {
  checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; style?: "switch" | "checkbox";
}) {
  const control = style === "switch" ? (
    <span className={`switch${checked ? " on" : ""}`} role="switch" aria-checked={checked}><span className="knob" /></span>
  ) : (
    <span className={`checkbox${checked ? " on" : ""}`} role="checkbox" aria-checked={checked}>{checked && <Symbol name="checkmark" size={9} />}</span>
  );
  return (
    <label className={`toggle toggle-${style}${disabled ? " disabled" : ""}`} onClick={(e) => { e.preventDefault(); if (!disabled) onChange(!checked); }}>
      {style === "checkbox" && control}
      {label != null && <span className="toggle-label">{label}</span>}
      {style === "switch" && control}
    </label>
  );
}

/** Picker — `.menu` (popup button) or `.segmented`. */
export function Picker<V extends string | number>({ value, onChange, options, style = "menu", disabled, width }: {
  value: V; onChange: (v: V) => void; options: { value: V; label: string }[]; style?: "menu" | "segmented"; disabled?: boolean; width?: number;
}) {
  if (style === "segmented") {
    return (
      <div className="segmented" style={{ width }}>
        {options.map((o) => (
          <button key={String(o.value)} disabled={disabled} className={o.value === value ? "selected" : ""} onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </div>
    );
  }
  return (
    <span className="popup" style={{ width }}>
      <select disabled={disabled} value={String(value)} onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}>
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
      <Symbol name="chevron.down" size={8} />
    </span>
  );
}

export function TextField({ value, onChange, placeholder, mono, autoFocus, width, onSubmit, disabled }: {
  value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; autoFocus?: boolean; width?: number | string; onSubmit?: () => void; disabled?: boolean;
}) {
  return (
    <input
      className={`textfield${mono ? " mono" : ""}`}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      spellCheck={false}
      style={{ width }}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") onSubmit?.(); }}
    />
  );
}

/** Stepper with a numeric field, like `Stepper(value:in:step:)` next to a TextField. */
export function Stepper({ value, onChange, min, max, step = 1 }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <span className="stepper">
      <button onClick={() => onChange(clamp(value + step))}>▴</button>
      <button onClick={() => onChange(clamp(value - step))}>▾</button>
    </span>
  );
}

/** Form(.grouped): sections of inset rows on the grouped background. */
export function Form({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div className="form-grouped" style={style}>{children}</div>;
}

export function Section({ header, footer, children }: { header?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="form-section">
      {header != null && <div className="form-section-header">{header}</div>}
      <div className="form-section-body">{children}</div>
      {footer != null && <div className="form-section-footer">{footer}</div>}
    </section>
  );
}

/** LabeledContent / a Form row: label left, control right. */
export function Row({ label, children, sub }: { label?: ReactNode; children?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="form-row">
      {label != null && (
        <div className="form-row-label">
          <div>{label}</div>
          {sub != null && <div className="form-row-sub">{sub}</div>}
        </div>
      )}
      <div className="form-row-control">{children}</div>
    </div>
  );
}

/** `.sheet` — a modal panel sliding from the window's title bar. */
export function Sheet({ open, onClose, width = 480, children }: { open: boolean; onClose: () => void; width?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-scrim">
      <div className="sheet" ref={ref} style={{ width }}>{children}</div>
    </div>
  );
}

/** `.alert` / `.confirmationDialog`. */
export function Alert({ open, title, message, actions }: {
  open: boolean; title: string; message?: ReactNode;
  actions: { label: string; role?: "cancel" | "destructive" | "default"; onClick: () => void }[];
}) {
  if (!open) return null;
  return (
    <div className="sheet-scrim alert-scrim">
      <div className="alert">
        <img className="alert-icon" src="/portly-icon.png" alt="" />
        <div className="alert-title">{title}</div>
        {message != null && <div className="alert-message">{message}</div>}
        <div className="alert-actions">
          {actions.map((a) => (
            <Button key={a.label} variant={a.role === "default" ? "prominent" : a.role === "destructive" ? "destructive" : "push"} onClick={a.onClick}>
              {a.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** ContentUnavailableView. */
export function ContentUnavailable({ symbol, title, description, actions }: { symbol: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="unavailable">
      <Symbol name={symbol} size={40} className="tertiary" />
      <div className="unavailable-title">{title}</div>
      {description != null && <div className="unavailable-desc">{description}</div>}
      {actions != null && <div className="unavailable-actions">{actions}</div>}
    </div>
  );
}

export function Divider({ vertical, style }: { vertical?: boolean; style?: CSSProperties }) {
  return <div className={vertical ? "divider-v" : "divider"} style={style} />;
}

export function ProgressSpinner({ size = 12 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}
