//! "Launch Portly at login" — the Windows counterpart of the macOS login item.
//!
//! A per-user `Run` entry starts `Portly.exe --hidden` (tray only) at sign-in.
//! Task Manager's Startup tab can disable the entry without removing it; that
//! state lives in `StartupApproved\Run` and counts as off here, and turning
//! the setting back on re-approves it. The installer writes the same values
//! (see installer/hooks.nsh), so both sides must agree on the names below.

use std::path::Path;
use windows_registry::{CURRENT_USER, Type};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const VALUE_NAME: &str = "Portly";
/// Records that the user made a choice, so the installer does not ask again.
const CHOICE_KEY: &str = r"Software\Portly";
const CHOICE_VALUE: &str = "LaunchAtLoginChosen";
/// What Explorer writes for an approved entry (first byte even = enabled).
const APPROVED_ON: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

fn command_for(exe: &Path) -> String {
    format!("\"{}\" --hidden", exe.display())
}

fn current_exe() -> Result<std::path::PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

fn run_command() -> Option<String> {
    CURRENT_USER.open(RUN_KEY).and_then(|k| k.get_string(VALUE_NAME)).ok()
}

fn approved() -> bool {
    match CURRENT_USER.open(APPROVED_KEY).and_then(|k| k.get_value(VALUE_NAME)) {
        Ok(v) => v.first().is_none_or(|b| b & 1 == 0),
        Err(_) => true,
    }
}

/// The executable a Run command starts: the quoted first token, or the whole
/// command up to " --" for an unquoted one.
fn command_exe(cmd: &str) -> &str {
    let cmd = cmd.trim();
    match cmd.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(rest),
        None => cmd.split(" --").next().unwrap_or(cmd).trim(),
    }
}

/// On when the Run entry exists and Task Manager has not disabled it. An entry
/// whose executable is gone (Portly moved or reinstalled elsewhere) is pointed
/// at this one; an entry for another existing Portly.exe, such as the installed
/// app while a dev build runs, is left alone.
pub fn is_enabled() -> Result<bool, String> {
    let Some(cmd) = run_command() else { return Ok(false) };
    if !approved() {
        return Ok(false);
    }
    if !Path::new(command_exe(&cmd)).is_file() {
        let want = command_for(&current_exe()?);
        // Best effort: reading the setting must not fail because of this.
        let _ = CURRENT_USER.create(RUN_KEY).and_then(|k| k.set_string(VALUE_NAME, &want));
    }
    Ok(true)
}

pub fn set_enabled(enabled: bool) -> Result<bool, String> {
    if enabled {
        let cmd = command_for(&current_exe()?);
        CURRENT_USER
            .create(RUN_KEY)
            .and_then(|k| k.set_string(VALUE_NAME, &cmd))
            .map_err(|e| format!("Could not add Portly to the startup apps: {e}"))?;
        CURRENT_USER
            .create(APPROVED_KEY)
            .and_then(|k| k.set_bytes(VALUE_NAME, Type::Bytes, &APPROVED_ON))
            .map_err(|e| format!("Could not enable Portly in the startup apps: {e}"))?;
    } else {
        for key in [RUN_KEY, APPROVED_KEY] {
            if let Ok(k) = CURRENT_USER.options().write().open(key) {
                // Missing values are already "off".
                let _ = k.remove_value(VALUE_NAME);
            }
        }
        if run_command().is_some() {
            return Err("Could not remove Portly from the startup apps.".into());
        }
    }
    let _ = CURRENT_USER.create(CHOICE_KEY).and_then(|k| k.set_u32(CHOICE_VALUE, 1));
    is_enabled()
}
