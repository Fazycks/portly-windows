//! Native shell of Portly for Windows: tray icon + popover (port of the macOS
//! MenuBarExtra), main and settings windows, presentation preferences,
//! autostart, single instance, and starting the Go daemon (portlyd.exe).

mod daemon;
mod prefs;
mod tray_glyph;

use prefs::Prefs;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Rect, RunEvent, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

const TRAY_ID: &str = "portly";
/// A click on the tray icon first blurs (and hides) the popover; the click that
/// follows must not reopen it.
const REOPEN_GUARD: Duration = Duration::from_millis(350);
/// Popover panel size in logical px (MenuBarContent: width 320).
const POPOVER_WIDTH: f64 = 320.0;
const POPOVER_HEIGHT: f64 = 300.0;
const POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Default)]
struct Shared {
    prefs: Prefs,
    /// running, total, problem — `Supervisor.runningCount` / `hasProblem`.
    counts: (u32, u32, bool),
    /// size, active, problem, white of the icon currently set on the tray.
    rendered: Option<(u32, bool, bool, bool)>,
    tooltip: String,
    /// Tray icon rect (physical px) of the last click, used to anchor the popover.
    anchor: Option<(PhysicalPosition<f64>, PhysicalSize<f64>)>,
    popover_hidden_at: Option<Instant>,
    /// Panel content height (CSS px) reported by the popover page; 0 until it renders.
    popover_height: f64,
}

struct AppState(Mutex<Shared>);

fn state(app: &AppHandle) -> std::sync::MutexGuard<'_, Shared> {
    app.state::<AppState>().inner().0.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------- tray

fn tray_image(size: u32, active: bool, problem: bool, white: bool) -> Image<'static> {
    Image::new_owned(tray_glyph::render(size, active, problem, white), size, size)
}

/// Re-renders the glyph and tooltip when something changed: counts, taskbar
/// theme, DPI or the "show name" preference. Never holds the lock while
/// talking to the tray (those calls hop to the main thread).
fn refresh_tray(app: &AppHandle) {
    let size = tray_glyph::tray_icon_size();
    let white = !tray_glyph::taskbar_is_light();
    let (icon, tooltip) = {
        let mut s = state(app);
        let (running, total, problem) = s.counts;
        let key = (size, running > 0, problem, white);
        let icon = (s.rendered != Some(key)).then(|| {
            s.rendered = Some(key);
            key
        });
        let text = if s.prefs.show_tray_name {
            format!("Portly — {running}/{total} running")
        } else {
            "Portly".to_string()
        };
        let tooltip = (s.tooltip != text).then(|| {
            s.tooltip = text.clone();
            text
        });
        (icon, tooltip)
    };
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    if let Some((size, active, problem, white)) = icon {
        let _ = tray.set_icon(Some(tray_image(size, active, problem, white)));
    }
    if let Some(text) = tooltip {
        let _ = tray.set_tooltip(Some(text));
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let size = tray_glyph::tray_icon_size();
    let white = !tray_glyph::taskbar_is_light();
    state(app).rendered = Some((size, false, false, white));
    state(app).tooltip = "Portly".into();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_image(size, false, false, white))
        .tooltip("Portly")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, button_state: MouseButtonState::Up, rect, .. } = event {
                if matches!(button, MouseButton::Left | MouseButton::Right) {
                    toggle_popover(tray.app_handle(), rect);
                }
            }
        })
        .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------- popover

fn hide_popover_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("popover") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            state(app).popover_hidden_at = Some(Instant::now());
        }
    }
}

fn toggle_popover(app: &AppHandle, rect: Rect) {
    let Some(win) = app.get_webview_window("popover") else { return };
    if win.is_visible().unwrap_or(false) {
        hide_popover_window(app);
        return;
    }
    {
        let mut s = state(app);
        if s.popover_hidden_at.is_some_and(|t| t.elapsed() < REOPEN_GUARD) {
            return;
        }
        // Windows reports the tray rect in physical pixels.
        s.anchor = Some((rect.position.to_physical(1.0), rect.size.to_physical(1.0)));
    }
    place_popover(app, &win);
    let _ = win.show();
    let _ = win.set_focus();
}

/// Puts the popover next to the tray icon, on the side away from the taskbar,
/// and keeps it inside the work area of that monitor.
fn place_popover(app: &AppHandle, win: &WebviewWindow) {
    let (ap, asz) = match state(app).anchor {
        Some(a) => a,
        None => match app.cursor_position() {
            Ok(p) => (p, PhysicalSize::new(1.0, 1.0)),
            Err(_) => return,
        },
    };
    let (cx, cy) = (ap.x + asz.width / 2.0, ap.y + asz.height / 2.0);
    let monitor = app
        .monitor_from_point(cx, cy)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    // Size for the monitor the popover opens on: a logical size would use the
    // scale of wherever the window was last, which differs across monitors.
    let scale = monitor.scale_factor();
    let height = match state(app).popover_height {
        h if h > 0.0 => h,
        _ => POPOVER_HEIGHT,
    };
    let (w, h) = ((POPOVER_WIDTH * scale).round(), (height * scale).round());
    let gap = 8.0 * scale;

    let wa = monitor.work_area();
    let (wl, wt) = (wa.position.x as f64, wa.position.y as f64);
    let (wr, wb) = (wl + wa.size.width as f64, wt + wa.size.height as f64);
    let (ml, mt) = (monitor.position().x as f64, monitor.position().y as f64);
    let (mr, mb) = (ml + monitor.size().width as f64, mt + monitor.size().height as f64);

    enum Edge {
        Top,
        Bottom,
        Left,
        Right,
    }
    let edge = if wt > mt {
        Edge::Top
    } else if wl > ml {
        Edge::Left
    } else if wr < mr {
        Edge::Right
    } else if wb < mb {
        Edge::Bottom
    } else {
        // Auto-hidden taskbar: nearest monitor edge to the icon.
        let d = [(cy - mt, 0), (mb - cy, 1), (cx - ml, 2), (mr - cx, 3)];
        match d.iter().min_by(|a, b| a.0.total_cmp(&b.0)).map(|d| d.1) {
            Some(0) => Edge::Top,
            Some(2) => Edge::Left,
            Some(3) => Edge::Right,
            _ => Edge::Bottom,
        }
    };
    let (x, y) = match edge {
        Edge::Bottom => (cx - w / 2.0, ap.y.min(wb) - gap - h),
        Edge::Top => (cx - w / 2.0, (ap.y + asz.height).max(wt) + gap),
        Edge::Left => ((ap.x + asz.width).max(wl) + gap, cy - h / 2.0),
        Edge::Right => (ap.x.min(wr) - gap - w, cy - h / 2.0),
    };
    let x = x.min(wr - gap - w).max(wl + gap);
    let y = y.min(wb - gap - h).max(wt + gap);
    let pos = PhysicalPosition::new(x.round() as i32, y.round() as i32);
    // Move first so a DPI change from crossing monitors is applied before the
    // final size; then size, then move again in case the move rescaled it.
    let _ = win.set_position(pos);
    let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
    let _ = win.set_position(pos);
}

// ---------------------------------------------------------------- windows

fn show_window(app: &AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let skip = !state(app).prefs.show_in_taskbar;
    let _ = w.unminimize();
    let _ = w.show();
    // Showing a window can bring its taskbar button back; re-apply.
    let _ = w.set_skip_taskbar(skip);
    let _ = w.set_focus();
}

fn apply_prefs(app: &AppHandle, prefs: &Prefs) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(prefs.show_in_tray);
    }
    for label in ["main", "settings"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_skip_taskbar(!prefs.show_in_taskbar);
        }
    }
    if !prefs.show_in_tray {
        hide_popover_window(app);
    }
    refresh_tray(app);
}

/// `--open server:<id>|project:<id>|resources|ports` (also `--open=<target>`).
fn parse_route(args: &[String]) -> Option<Value> {
    let mut target = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--open" {
            target = it.next().cloned();
        } else if let Some(t) = a.strip_prefix("--open=") {
            target = Some(t.to_string());
        }
    }
    let target = target?;
    match target.split_once(':') {
        Some(("server", id)) if !id.is_empty() => Some(json!({ "kind": "server", "id": id })),
        Some(("project", id)) if !id.is_empty() => Some(json!({ "kind": "project", "id": id })),
        _ => match target.as_str() {
            "resources" => Some(json!({ "kind": "resources" })),
            "ports" => Some(json!({ "kind": "ports" })),
            _ => None,
        },
    }
}

fn is_hidden_launch(args: &[String]) -> bool {
    args.iter().any(|a| a == "--hidden")
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn open_main(app: AppHandle, route: Option<Value>) {
    hide_popover_window(&app);
    show_window(&app, "main");
    if let Some(route) = route.filter(|r| !r.is_null()) {
        let _ = app.emit_to("main", "navigate", route);
    }
}

#[tauri::command]
fn open_settings(app: AppHandle, tab: Option<String>) {
    hide_popover_window(&app);
    show_window(&app, "settings");
    if let Some(tab) = tab {
        let _ = app.emit_to("settings", "settings-tab", tab);
    }
}

/// The popover page reports its content height so the window hugs the panel.
#[tauri::command]
fn set_popover_height(app: AppHandle, height: f64) {
    if !(height.is_finite() && height > 0.0) {
        return;
    }
    let changed = {
        let mut s = state(&app);
        let changed = (s.popover_height - height).abs() >= 0.5;
        s.popover_height = height;
        changed
    };
    if let Some(win) = app.get_webview_window("popover") {
        if changed && win.is_visible().unwrap_or(false) {
            place_popover(&app, &win);
        }
    }
}

#[tauri::command]
fn hide_popover(app: AppHandle) {
    hide_popover_window(&app);
}

/// The daemon stops every server on /quit; then the app exits.
#[tauri::command]
async fn quit_app(app: AppHandle) {
    let port = daemon::api_port();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        daemon::request(port, "POST", "/quit", Some("{}"), Duration::from_secs(15))
    })
    .await;
    app.exit(0);
}

#[tauri::command]
fn set_tray_state(app: AppHandle, running: u32, total: u32, problem: bool) {
    state(&app).counts = (running, total, problem);
    refresh_tray(&app);
}

#[tauri::command]
fn get_prefs(app: AppHandle) -> Prefs {
    state(&app).prefs
}

#[tauri::command]
fn set_prefs(app: AppHandle, prefs: Value) -> Result<Prefs, String> {
    let next = {
        let mut s = state(&app);
        let next = s.prefs.merged(&prefs);
        s.prefs = next;
        next
    };
    next.save().map_err(|e| e.to_string())?;
    apply_prefs(&app, &next);
    let _ = app.emit("prefs-changed", next);
    Ok(next)
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())?;
    launcher.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_config(app: AppHandle) -> Result<(), String> {
    let dir = daemon::config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn api_port() -> u16 {
    daemon::api_port()
}

// ---------------------------------------------------------------- startup

fn daemon_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut c = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        c.push(dir.join("bin").join("portlyd.exe"));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)) {
        c.push(dir.join("bin").join("portlyd.exe"));
    }
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("PORTLYD_PATH") {
        c.push(PathBuf::from(p));
    }
    c
}

/// Lets the CLI (`portly open`) find the app.
fn write_app_path() {
    let dir = daemon::config_dir();
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("app-path.txt"), exe.to_string_lossy().as_bytes());
    }
}

fn spawn_background(app: &AppHandle) {
    let candidates = daemon_candidates(app);
    let handle = app.clone();
    std::thread::spawn(move || {
        daemon::ensure_running(&candidates);
        // Hidden webviews throttle their timers, so the tray glyph is also fed
        // from here. This also picks up taskbar theme and DPI changes.
        loop {
            if let Some(counts) = daemon::tray_counts(daemon::api_port()) {
                state(&handle).counts = counts;
            }
            refresh_tray(&handle);
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(route) = parse_route(&argv) {
                open_main(app.clone(), Some(route));
            } else if !is_hidden_launch(&argv) {
                open_main(app.clone(), None);
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState(Mutex::new(Shared { prefs: Prefs::load(), ..Default::default() })))
        .setup(|app| {
            let handle = app.handle().clone();
            write_app_path();
            build_tray(&handle)?;
            let prefs = state(&handle).prefs;
            apply_prefs(&handle, &prefs);
            spawn_background(&handle);

            let args: Vec<String> = std::env::args().collect();
            if let Some(route) = parse_route(&args) {
                show_window(&handle, "main");
                // Let the main view mount and subscribe to "navigate" first.
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    let _ = h.emit_to("main", "navigate", route);
                });
            } else if !is_hidden_launch(&args) {
                show_window(&handle, "main");
            }
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            ("main" | "settings", WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let app = window.app_handle();
                // Without a tray icon, a hidden window would be unreachable:
                // keep the taskbar button like the macOS Dock icon.
                if window.label() == "main" && !state(app).prefs.show_in_tray {
                    let _ = window.minimize();
                } else {
                    let _ = window.hide();
                }
            }
            ("popover", WindowEvent::Focused(false)) => hide_popover_window(window.app_handle()),
            ("popover", WindowEvent::Resized(_)) => {
                if window.is_visible().unwrap_or(false) {
                    if let Some(w) = window.app_handle().get_webview_window("popover") {
                        place_popover(window.app_handle(), &w);
                    }
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            open_main,
            open_settings,
            hide_popover,
            set_popover_height,
            quit_app,
            set_tray_state,
            get_prefs,
            set_prefs,
            get_autostart,
            set_autostart,
            reveal_config,
            api_port
        ])
        .build(tauri::generate_context!())
        .expect("error while building Portly")
        .run(|_app, event| {
            // Closing windows keeps Portly in the tray; only quit_app exits.
            if let RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
