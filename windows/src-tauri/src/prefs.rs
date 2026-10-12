//! App presentation preferences, port of `AppPresentation` + `PortlyPreferences`
//! (menu bar item → tray icon, Dock → taskbar). Stored as JSON in
//! %APPDATA%\Portly\app-preferences.json; the daemon owns config.json.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

use crate::daemon::config_dir;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// showMenuBarItem
    pub show_in_tray: bool,
    /// showMenuBarName (tooltip "Portly — N/M running")
    pub show_tray_name: bool,
    /// showInDock
    pub show_in_taskbar: bool,
    pub agent_onboarding_dismissed: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { show_in_tray: true, show_tray_name: false, show_in_taskbar: true, agent_onboarding_dismissed: false }
    }
}

fn path() -> PathBuf {
    config_dir().join("app-preferences.json")
}

impl Prefs {
    /// Portly must keep at least one of the tray icon and the taskbar button.
    fn normalized(mut self) -> Self {
        if !self.show_in_tray && !self.show_in_taskbar {
            self.show_in_tray = true;
        }
        self
    }

    pub fn load() -> Self {
        fs::read_to_string(path())
            .ok()
            .and_then(|s| serde_json::from_str::<Prefs>(&s).ok())
            .unwrap_or_default()
            .normalized()
    }

    pub fn save(&self) -> std::io::Result<()> {
        fs::create_dir_all(config_dir())?;
        let json = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        fs::write(path(), json)
    }

    /// Applies a partial update (`Partial<Prefs>` from the webview) with the
    /// same rules as `AppPresentation.setShowInDock` / `setShowMenuBar`.
    pub fn merged(mut self, patch: &Value) -> Self {
        let get = |key: &str| patch.get(key).and_then(Value::as_bool);
        if let Some(v) = get("showTrayName") {
            self.show_tray_name = v;
        }
        if let Some(v) = get("agentOnboardingDismissed") {
            self.agent_onboarding_dismissed = v;
        }
        if let Some(v) = get("showInTaskbar") {
            self.show_in_taskbar = v;
            if !v && !self.show_in_tray {
                self.show_in_tray = true;
            }
        }
        if let Some(v) = get("showInTray") {
            self.show_in_tray = v;
            if !v && !self.show_in_taskbar {
                self.show_in_taskbar = true;
            }
        }
        self.normalized()
    }
}
