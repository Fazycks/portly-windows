//! The Go daemon (portlyd.exe) is the supervisor and serves the control API on
//! 127.0.0.1:<apiPort>. This module finds it, starts it when nothing listens,
//! and speaks just enough HTTP/1.0 for /quit and /status.

use serde_json::Value;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DEFAULT_PORT: u16 = 7737;

/// %APPDATA%\Portly — shared with the daemon and the CLI. PORTLY_HOME
/// overrides it, as it does for them (cli/paths.go).
pub fn config_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("PORTLY_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(home);
    }
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("AppData").join("Roaming")))
        .unwrap_or_else(std::env::temp_dir)
        .join("Portly")
}

/// The port the running daemon is bound to (daemon.port), else the configured
/// one. A new "apiPort" in config.json only applies once the daemon restarts,
/// so the app must keep using the bound port until then.
pub fn api_port() -> u16 {
    std::fs::read_to_string(config_dir().join("daemon.port"))
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|p| *p != 0 && is_listening(*p))
        .unwrap_or_else(configured_port)
}

/// config.json "apiPort", or 7737.
pub fn configured_port() -> u16 {
    std::fs::read_to_string(config_dir().join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("apiPort").and_then(Value::as_u64))
        .filter(|p| (1..=65535).contains(p))
        .map(|p| p as u16)
        .unwrap_or(DEFAULT_PORT)
}

fn addr(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

pub fn is_listening(port: u16) -> bool {
    TcpStream::connect_timeout(&addr(port), Duration::from_millis(400)).is_ok()
}

/// Minimal HTTP/1.0 request (no chunked encoding, body ends at close).
/// Returns the response body.
pub fn request(port: u16, method: &str, path: &str, body: Option<&str>, timeout: Duration) -> std::io::Result<String> {
    let mut stream = TcpStream::connect_timeout(&addr(port), Duration::from_millis(800))?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let body = body.unwrap_or("");
    let head = if method == "GET" {
        format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
    } else {
        format!(
            "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
    };
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw);
    Ok(text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default())
}

/// Running / total / problem over every configured server, like
/// `Supervisor.runningCount` and `hasProblem`. None when the daemon is down.
pub fn tray_counts(port: u16) -> Option<(u32, u32, bool)> {
    let body = request(port, "GET", "/status", None, Duration::from_secs(3)).ok()?;
    let v: Value = serde_json::from_str(&body).ok()?;
    if v.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let (mut running, mut total, mut problem) = (0, 0, false);
    for project in v.pointer("/data/projects")?.as_array()? {
        for server in project.get("servers").and_then(Value::as_array).into_iter().flatten() {
            total += 1;
            match server.get("state").and_then(Value::as_str).unwrap_or("stopped") {
                "starting" | "running" | "restarting" => running += 1,
                "unhealthy" => {
                    running += 1;
                    problem = true;
                }
                "failed" => problem = true,
                _ => {}
            }
        }
    }
    Some((running, total, problem))
}

/// Starts `<portlyd> daemon` detached when nothing answers on the API port.
/// Candidates are tried in order; returns the binary that was launched.
pub fn ensure_running(candidates: &[PathBuf]) -> Option<PathBuf> {
    if is_listening(api_port()) {
        return None;
    }
    let exe = candidates.iter().find(|p| p.is_file())?;
    match spawn_detached(exe) {
        Ok(()) => Some(exe.clone()),
        Err(e) => {
            eprintln!("portly: failed to start {}: {e}", exe.display());
            None
        }
    }
}

fn spawn_detached(exe: &Path) -> std::io::Result<()> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("daemon")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No CREATE_NEW_PROCESS_GROUP: it would make the daemon, and every
        // server it starts, ignore Ctrl+C.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.spawn().map(|_| ())
}
