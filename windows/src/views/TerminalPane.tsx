// Port of TerminalPane.swift: the server's live terminal on a fixed dark
// surface. SwiftTerm is replaced by xterm.js fed from the daemon's PTY buffer.
import { useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/api";
import "./TerminalPane.css";

/** The terminal's colours, in one place (TerminalTheme). */
export const TerminalTheme = {
  background: "rgb(11, 13, 18)", // srgb(0.043, 0.051, 0.071)
  foreground: "rgb(214, 219, 230)", // srgb(0.84, 0.86, 0.9)
  border: "rgb(51, 59, 74)", // srgb(0.2, 0.23, 0.29)
  surfaceInset: 10,
  textInset: 12,
  cornerRadius: 10,
};

/** ServerRuntime.terminalView(): caret, selection and the editor-inspired ANSI palette. */
const theme: ITheme = {
  background: TerminalTheme.background,
  foreground: TerminalTheme.foreground,
  cursor: "rgb(125, 199, 255)", // srgb(0.49, 0.78, 1)
  cursorAccent: TerminalTheme.background,
  selectionBackground: "rgb(41, 56, 82)", // srgb(0.16, 0.22, 0.32)
  selectionForeground: "rgb(245, 247, 252)", // srgb(0.96, 0.97, 0.99)
  black: "#1B1D23",
  red: "#FF6B81",
  green: "#A7D46F",
  yellow: "#F5C76D",
  blue: "#82AAFF",
  magenta: "#C792EA",
  cyan: "#63D4D5",
  white: "#D8DEE9",
  brightBlack: "#5C6370",
  brightRed: "#FF879A",
  brightGreen: "#C3E88D",
  brightYellow: "#FFD580",
  brightBlue: "#9CC4FF",
  brightMagenta: "#DDB6F2",
  brightCyan: "#89DDFF",
  brightWhite: "#FFFFFF",
};

function monoFontFamily() {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return v || '"Cascadia Mono", Consolas, monospace';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hosts one server's live terminal. Mount with `key={serverId}` so switching
 * servers swaps the view; the daemon replays scrollback from offset 0.
 * Bump `clearToken` to reset the screen (ServerRuntime.clearTerminal).
 */
export default function TerminalPane({ serverId, clearToken = 0 }: { serverId: string; clearToken?: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: monoFontFamily(),
      fontSize: 13,
      theme,
      scrollback: 10000,
      allowTransparency: false,
      drawBoldTextInBrightColors: true, // useBrightColors
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    let alive = true;
    const abort = new AbortController();

    // Size: fit to the surface, then tell the PTY.
    let lastCols = 0;
    let lastRows = 0;
    let frame = 0;
    const doFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!alive || host.clientWidth === 0 || host.clientHeight === 0) return;
        try { fit.fit(); } catch { return; }
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols;
          lastRows = term.rows;
          api.resize(serverId, term.cols, term.rows).catch(() => {});
        }
      });
    };
    const observer = new ResizeObserver(doFit);
    observer.observe(host);
    doFit();
    // Web fonts can land after the first fit and change the cell size.
    document.fonts?.ready.then(() => { if (alive) doFit(); });

    // Keystrokes → PTY.
    const input = term.onData((data) => { api.input(serverId, data).catch(() => {}); });

    // Output: long-poll the daemon buffer.
    (async () => {
      let offset = 0;
      while (alive) {
        try {
          const chunk = await api.output(serverId, offset, abort.signal);
          if (!alive) break;
          if (chunk.reset) term.reset();
          if (chunk.data) term.write(chunk.data);
          offset = chunk.offset;
        } catch {
          if (!alive) break;
          await sleep(1000);
        }
      }
    })();

    // window?.makeFirstResponder(view)
    term.focus();

    return () => {
      alive = false;
      abort.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      input.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [serverId]);

  useEffect(() => {
    if (clearToken > 0) termRef.current?.reset();
  }, [clearToken]);

  return (
    <div className="terminal-pane" style={{ padding: TerminalTheme.surfaceInset }}>
      <div
        className="terminal-surface"
        style={{
          padding: TerminalTheme.textInset,
          borderRadius: TerminalTheme.cornerRadius,
          background: TerminalTheme.background,
          borderColor: TerminalTheme.border,
        }}
        onMouseDown={() => termRef.current?.focus()}
      >
        <div ref={hostRef} className="terminal-host" />
      </div>
    </div>
  );
}
