// One bundle, three Tauri windows: the hash picks the scene, mirroring
// PortlyApp.swift's Window / MenuBarExtra / Settings scenes.
import { useEffect, useState } from "react";
import MainView from "./views/MainView";
import MenuBarContent from "./views/MenuBarContent";
import SettingsView from "./views/SettingsView";

const route = () => window.location.hash.replace(/^#\/?/, "") || "main";

export default function App() {
  const [scene, setScene] = useState(route());
  useEffect(() => {
    const onHash = () => setScene(route());
    window.addEventListener("hashchange", onHash);
    // No browser context menu or reload accelerators: this is a native-looking app.
    const onMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea, .selectable, .xterm")) e.preventDefault();
    };
    window.addEventListener("contextmenu", onMenu);
    return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("contextmenu", onMenu); };
  }, []);
  if (scene.startsWith("popover")) return <MenuBarContent />;
  if (scene.startsWith("settings")) return <SettingsView />;
  return <MainView />;
}
