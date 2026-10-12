// Port of MenuBarContent.swift: the tray popover. Everything you need without
// opening the window, and a way in when you do.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { api, type ProjectStatus, type ServerStatus } from "../lib/api";
import { native } from "../lib/native";
import { act, usePortly, useCounts } from "../lib/store";
import { Symbol } from "../lib/symbols";
import { Divider, hexColor, StartStopButton, StatusDot } from "../components/ui";
import "./MenuBarContent.css";

const WIDTH = 320;

export default function MenuBarContent() {
  const { status } = usePortly();
  const { running, total, problem } = useCounts();
  const panel = useRef<HTMLDivElement>(null);
  const projects = status?.projects ?? [];

  // The popover window is transparent: only the rounded panel paints.
  useLayoutEffect(() => {
    document.documentElement.classList.add("popover-scene");
  }, []);

  // This hidden-at-startup window keeps polling, so it drives the tray glyph.
  useEffect(() => {
    void native.setTrayState(running, total, problem).catch(() => {});
  }, [running, total, problem]);

  // A menu bar window sizes itself to its content: follow the panel's height.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    let last = 0;
    const fit = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0 && h !== last) {
        last = h;
        void getCurrentWindow().setSize(new LogicalSize(WIDTH, h)).catch(() => {});
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dismissThen = (fn: () => unknown) => {
    void native.hidePopover().catch(() => {});
    void Promise.resolve(fn()).catch(() => {});
  };

  return (
    <div className="mb" ref={panel}>
      <div className="mb-header">
        <span className="mb-title">Portly</span>
        <span className="mb-spacer" />
        <span className="mb-summary digits">{running}/{total} running</span>
      </div>

      <Divider />

      {projects.length === 0 ? (
        <div className="mb-empty">
          <div className="mb-empty-title">No projects yet</div>
          <div className="mb-empty-desc">Open the window to add a project and its servers.</div>
        </div>
      ) : (
        <div className="mb-scroll">
          <div className="mb-list">
            {projects.map((p) => (
              <ProjectSection key={p.id} project={p} onOpenServer={(id) => dismissThen(() => native.openMain({ kind: "server", id }))} />
            ))}
          </div>
        </div>
      )}

      <Divider />

      <div className="mb-footer">
        <button className="mb-link" onClick={() => dismissThen(() => native.openMain())}>Open Portly</button>
        <button className="mb-link" onClick={() => dismissThen(() => native.openMain({ kind: "ports" }))}>Ports</button>
        <button className="mb-link" onClick={() => dismissThen(() => native.openSettings())}>Settings…</button>
        <span className="mb-spacer" />
        <button
          className="mb-link"
          disabled={running === 0}
          title="Stop every running server and temporary process"
          aria-label="Kill All"
          onClick={() => void act(() => api.stopAll()).catch(() => {})}
        >
          Kill All
        </button>
        <button className="mb-link" onClick={() => void native.quit().catch(() => {})}>Quit</button>
      </div>
    </div>
  );
}

function ProjectSection({ project, onOpenServer }: { project: ProjectStatus; onOpenServer: (id: string) => void }) {
  return (
    <div className="mb-section">
      <div className="mb-project">
        <span className="mb-project-icon" style={{ color: hexColor(project.color) }}>
          <Symbol name={project.icon} size={11} />
        </span>
        <span className="mb-project-name">{project.name}</span>
        <span className="mb-spacer" />
        <button
          className="borderless"
          title={`Start every server in ${project.name}`}
          onClick={() => void act(() => api.start({ project: project.id })).catch(() => {})}
        >
          <Symbol name="play.fill" size={9} />
        </button>
        <button
          className="borderless"
          title={`Stop every server in ${project.name}`}
          onClick={() => void act(() => api.stop({ project: project.id })).catch(() => {})}
        >
          <Symbol name="stop.fill" size={9} />
        </button>
      </div>
      {project.servers.map((s) => (
        <ServerRow key={s.id} server={s} onOpen={() => onOpenServer(s.id)} />
      ))}
    </div>
  );
}

function ServerRow({ server, onOpen }: { server: ServerStatus; onOpen: () => void }) {
  const [hovering, setHovering] = useState(false);
  return (
    <div
      className={`mb-row${hovering ? " hover" : ""}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={onOpen}
    >
      <StatusDot state={server.state} />
      <span className="mb-row-name">{server.name}</span>
      {server.port != null && <span className="mb-row-port">:{String(server.port)}</span>}
      <span className="mb-row-spacer" />
      <StartStopButton server={server} symbolSize={9} />
    </div>
  );
}
