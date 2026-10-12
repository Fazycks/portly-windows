// Bridge to the Rust shell (src-tauri/src/lib.rs). These commands and events are
// the contract between the React views and the native side: windows, tray,
// presentation preferences and folder pickers.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";

/** Mirrors PortlyPreferences + AppPresentation (menu bar → tray, Dock → taskbar). */
export interface Prefs {
  showInTray: boolean;          // showMenuBarItem
  showTrayName: boolean;        // showMenuBarName (tooltip "Portly — N running")
  showInTaskbar: boolean;       // showInDock
  agentOnboardingDismissed: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  showInTray: true,
  showTrayName: false,
  showInTaskbar: true,
  agentOnboardingDismissed: false,
};

export type MainRoute =
  | { kind: "resources" }
  | { kind: "ports" }
  | { kind: "project"; id: string }
  | { kind: "server"; id: string };

export const native = {
  /** Show + focus the main window; optionally navigate it. */
  openMain: (route?: MainRoute) => invoke("open_main", { route: route ?? null }),
  /** Show the Settings window on a tab: "general" | "servers" | "memory" | "inactivity". */
  openSettings: (tab?: string) => invoke("open_settings", { tab: tab ?? null }),
  hidePopover: () => invoke("hide_popover"),
  /** Stops every server through the daemon, then exits (the app is the supervisor). */
  quit: () => invoke("quit_app"),
  /** Tray glyph: dot filled when something runs, warning badge on problems. */
  setTrayState: (running: number, total: number, problem: boolean) =>
    invoke("set_tray_state", { running, total, problem }),
  getPrefs: () => invoke<Prefs>("get_prefs"),
  setPrefs: (prefs: Partial<Prefs>) => invoke<Prefs>("set_prefs", { prefs }),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<boolean>("set_autostart", { enabled }),
  /** Open the config folder (%APPDATA%\Portly) in Explorer. */
  revealConfig: () => invoke("reveal_config"),
  apiPort: () => invoke<number>("api_port"),
};

export const pickFolder = async (title = "Choose a folder", defaultPath?: string) => {
  const r = await openDialog({ directory: true, multiple: false, title, defaultPath });
  return typeof r === "string" ? r : null;
};

export const openExternal = (url: string) => openUrl(url);
export const reveal = (path: string) => revealItemInDir(path);

/** Main window navigation requests coming from the tray, `portly open`, notifications. */
export function onNavigate(cb: (route: MainRoute) => void): Promise<UnlistenFn> {
  return listen<MainRoute>("navigate", (e) => cb(e.payload));
}

export function onSettingsTab(cb: (tab: string) => void): Promise<UnlistenFn> {
  return listen<string>("settings-tab", (e) => cb(e.payload));
}

/** Live preferences shared by every window (Rust emits "prefs-changed"). */
/** The third value is false until the stored prefs arrive, so first-run UI
 *  (the agent onboarding card) does not flash for users who dismissed it. */
export function usePrefs(): [Prefs, (p: Partial<Prefs>) => Promise<void>, boolean] {
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let alive = true;
    native
      .getPrefs()
      .then((p) => alive && setPrefsState(p))
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    listen<Prefs>("prefs-changed", (e) => {
      setPrefsState(e.payload);
      setLoaded(true);
    }).then((u) => (alive ? (un = u) : u()));
    return () => {
      alive = false;
      un?.();
    };
  }, []);
  const update = async (p: Partial<Prefs>) => {
    const next = await native.setPrefs(p);
    setPrefsState(next);
  };
  return [prefs, update, loaded];
}
