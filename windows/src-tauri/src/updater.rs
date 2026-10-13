//! Update check when the Portly process starts: once per launch (sign-in or
//! starting Portly.exe), never when a window is merely reopened from the tray,
//! since Portly keeps running in the background.
//!
//! The feed is `latest.json` on the latest GitHub release (see tauri.conf.json
//! `plugins.updater`); packages are verified against the bundled public key.
//! When an update exists it is downloaded and its installer started in passive
//! mode (progress bar only); this process then exits and the installer
//! relaunches Portly with the same arguments, so a `--hidden` launch stays
//! hidden. Any failure (offline, feed missing, bad signature) only skips the
//! update until the next launch.

use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Covers the feed request and the installer download.
const TIMEOUT: Duration = Duration::from_secs(120);

/// At sign-in (`--hidden`) Portly often starts before the network is up, so a
/// failed check is retried this many times, RETRY_DELAY apart. A manual launch
/// tries once and does not keep an offline machine waiting.
const LOGIN_RETRIES: u32 = 6;
const RETRY_DELAY: Duration = Duration::from_secs(5);

/// Blocks the calling thread. Returns when Portly is up to date or the check
/// failed; when an update is installed the process exits instead.
pub fn update_on_launch(app: &AppHandle, at_login: bool) {
    // A dev build would be "updated" into the installed release.
    if cfg!(debug_assertions) {
        return;
    }
    remove_old_installers();
    let retries = if at_login { LOGIN_RETRIES } else { 0 };
    for attempt in 0..=retries {
        if attempt > 0 {
            std::thread::sleep(RETRY_DELAY);
        }
        match tauri::async_runtime::block_on(check_and_install(app.clone())) {
            Ok(()) => return,
            Err(e) => eprintln!("Portly update check failed: {e}"),
        }
    }
}

/// The plugin keeps each downloaded installer in `%TEMP%\Portly-<version>-updater-*`;
/// by the time Portly runs again, that installer has finished.
fn remove_old_installers() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("Portly-") && name.contains("-updater-") && entry.path().is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

async fn check_and_install(app: AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater_builder().timeout(TIMEOUT).build()?.check().await? else {
        return Ok(());
    };
    update.download_and_install(|_, _| {}, || {}).await
}
