// Port of MainView.swift's private ProjectDetail / ProjectServerRow.
import { api, type Project, type ServerStatus } from "../lib/api";
import { act } from "../lib/store";
import { Button, Divider, StartStopButton, StatusDot, T, hexColor, stateLabel } from "../components/ui";
import { DetailToolbar, ToolbarButton } from "./Toolbar";
import { Icon, abbreviatePath } from "./serverInfo";

export default function ProjectDetail({ project, runtime, onAddServer, onEdit, onSelectServer }: {
  project: Project;
  runtime: (serverId: string) => ServerStatus | undefined;
  onAddServer: () => void;
  onEdit: () => void;
  onSelectServer: (serverId: string) => void;
}) {
  return (
    <div className="project-detail">
      <DetailToolbar title={project.name}>
        <ToolbarButton symbol="play.fill" label="Start All" help="Start every server in this project"
          onClick={() => void act(() => api.start({ project: project.id }))} />
        <ToolbarButton symbol="stop.fill" label="Stop All" help="Stop every server in this project"
          onClick={() => void act(() => api.stop({ project: project.id }))} />
        <ToolbarButton symbol="plus" label="Add Server" onClick={onAddServer} />
        <ToolbarButton symbol="slider.horizontal.3" label="Edit Project" onClick={onEdit} />
      </DetailToolbar>

      <div className="project-detail-header">
        <span className="project-detail-icon" style={{ color: hexColor(project.color) }}>
          <Icon name={project.icon} size={24} />
        </span>
        <div className="project-detail-titles">
          <div style={T.title}>{project.name}</div>
          <div style={T.metadata} className="secondary selectable">{abbreviatePath(project.root)}</div>
        </div>
      </div>

      <Divider />

      {project.servers.length === 0 ? (
        <div className="project-detail-empty">
          <div className="secondary">No servers in this project yet.</div>
          <Button onClick={onAddServer}>Add Server…</Button>
        </div>
      ) : (
        <div className="project-detail-list">
          {project.servers.map((server) => {
            const status = runtime(server.id);
            return status ? (
              <ProjectServerRow key={server.id} server={status} onSelect={() => onSelectServer(server.id)} />
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

function ProjectServerRow({ server, onSelect }: { server: ServerStatus; onSelect: () => void }) {
  return (
    <div className="project-server-row" onDoubleClick={onSelect}>
      <StatusDot state={server.state} />
      <div className="project-server-texts">
        <div style={T.bodyMedium} className="truncate">{server.name}</div>
        <div style={T.metadata} className="secondary truncate">{server.command}</div>
      </div>
      <span key={server.state} className="state-label secondary" style={T.label}>{stateLabel(server.state)}</span>
      <StartStopButton server={server} />
    </div>
  );
}
