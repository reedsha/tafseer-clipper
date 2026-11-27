//! Tauri v2 desktop shell for Tafseer Clipper.
//!
//! Per `AGENTS.md` §3 the Rust side owns exactly five things:
//! the window lifecycle, spawning/pinging the Python sidecar, injecting the
//! renderer's boot configuration, terminating the sidecar on exit, and
//! provisioning the optional GPU acceleration pack. Every piece of application
//! logic lives in the React renderer and in the FastAPI sidecar — nothing here
//! does business work.

mod acceleration;
mod job_object;
mod secrets;

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_fs::FsExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Window label declared in `tauri.conf.json` and targeted by the capability.
const MAIN_WINDOW_LABEL: &str = "main";

/// Folder inside the app's resource directory holding the PyInstaller onedir
/// sidecar. `tauri.conf.json` maps the `build/sidecar/backend/` staging folder
/// here, and the NSIS installer lays it out as `<install>\backend\`.
const SIDECAR_RESOURCE_DIR: &str = "backend";

#[cfg(windows)]
const SIDECAR_EXE: &str = "backend.exe";
#[cfg(not(windows))]
const SIDECAR_EXE: &str = "backend";

/// Port used when the sidecar cannot be spawned (for example a dev run where
/// the sidecar folder was not staged) so a manually started backend still
/// answers.
const FALLBACK_SIDECAR_PORT: u16 = 8008;

/// How long the shell waits for the sidecar's stdout handshake.
///
/// A frozen onedir build has to unpack and import torch/whisper, and antivirus
/// can scan it on first launch. The old 10 s limit expired while the sidecar was
/// already listening on its own port, so the renderer was pointed at 8008 and
/// reported "Engine not responding". The E2E handshake test allows 30 s; match it.
const SIDECAR_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Process-wide handle to the spawned sidecar and the tray that keeps it alive
/// while the window is hidden.
struct SidecarState {
    /// `None` when spawning failed; the renderer then talks to the fallback port.
    child: Mutex<Option<CommandChild>>,
    /// Win32 Job Object owning the sidecar tree (`KILL_ON_JOB_CLOSE` on drop).
    job_object: Mutex<Option<job_object::SidecarJobObject>>,
    /// Kept so `set_running_jobs` can refresh the tooltip.
    tray: Mutex<Option<TrayIcon>>,
    /// Number of tasks the renderer reports as running; drives the close dialog
    /// and the tray tooltip.
    running_jobs: AtomicUsize,
}

/// Writable, user-scoped directories handed to `backend.exe` through the
/// environment. Keeping them under `%LOCALAPPDATA%` means imported fonts and
/// job files survive reinstalls and are writable in packaged builds.
struct SidecarPaths {
    fonts_dir: PathBuf,
    work_dir: PathBuf,
}

/// Resolve the base data directory, preferring the Windows `%LOCALAPPDATA%`
/// environment variable and falling back to Tauri's path resolver.
pub(crate) fn local_app_data_dir(app: &tauri::AppHandle) -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| app.path().local_data_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn sidecar_paths(app: &tauri::AppHandle) -> SidecarPaths {
    let root = local_app_data_dir(app).join("Tafseer Clipper");
    SidecarPaths {
        fonts_dir: root.join("fonts"),
        work_dir: root.join("work"),
    }
}

/// The renderer reads `window.__TAFSEER_SIDECAR_URL__` while its modules
/// evaluate, so the value is injected as a webview initialization script that
/// runs before any page script.
fn initialization_script(sidecar_url: &str) -> String {
    let url = serde_json::to_string(sidecar_url)
        .unwrap_or_else(|_| format!("\"http://127.0.0.1:{FALLBACK_SIDECAR_PORT}\""));
    format!("window.__TAFSEER_SIDECAR_URL__ = {url};\n")
}

/// Resolve the bundled onedir sidecar at
/// `resource_dir()/backend/backend.exe`.
///
/// The NSIS installer puts resources next to the app executable, and
/// `tauri-build` copies the same folder next to `target/<profile>` so
/// `cargo run` / `tauri dev` resolve it the same way.  Returns `None` (never
/// panics) when the folder was not staged, so the shell can fall back to a
/// manually launched backend on `FALLBACK_SIDECAR_PORT`.
fn sidecar_executable(app: &tauri::AppHandle) -> Option<PathBuf> {
    let resource_dir = match app.path().resource_dir() {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("[tafseer] could not resolve the resource directory ({error})");
            return None;
        }
    };
    let candidate = resource_dir
        .join(SIDECAR_RESOURCE_DIR)
        .join(SIDECAR_EXE);
    if candidate.is_file() {
        Some(candidate)
    } else {
        eprintln!(
            "[tafseer] sidecar not found at {} (run scripts/build-release.ps1 \
             -SkipSigning, or pass -SkipSidecar to reuse the staged build)",
            candidate.display()
        );
        None
    }
}

/// Spawn `backend.exe` with an ephemeral port negotiated over stdout.
/// Returns the child handle and the negotiated port (if the handshake succeeded)
/// so the caller can inject the sidecar URL. Never panics.
fn spawn_sidecar(
    app: &tauri::AppHandle,
    paths: &SidecarPaths,
    cuda_dir: Option<&Path>,
) -> (Option<CommandChild>, Option<job_object::SidecarJobObject>, Option<u16>) {
    let Some(executable) = sidecar_executable(app) else {
        eprintln!(
            "[tafseer] falling back to 127.0.0.1:{FALLBACK_SIDECAR_PORT}"
        );
        return (None, None, None);
    };
    let command = app.shell().command(&executable);

    let mut command = command
        .env("TAFSEER_HOST", "127.0.0.1")
        .env("TAFSEER_PORT", "0")
        // The sidecar watches this PID and exits if the shell dies without
        // running its shutdown handler (crash / Task Manager "End task").
        .env("TAFSEER_PARENT_PID", std::process::id().to_string())
        .env("TAFSEER_FONTS_DIR", paths.fonts_dir.as_os_str())
        .env("TAFSEER_WORK_DIR", paths.work_dir.as_os_str())
        // Kill the whole job object on Windows so FFmpeg/Whisper children die too.
        .set_process_group(true)
        .kill_on_drop(true);

    // Optional GPU acceleration pack: the sidecar registers this directory for
    // DLL loading. Without it the sidecar falls back to CPU (always available).
    if let Some(dir) = cuda_dir {
        command = command.env("TAFSEER_CUDA_DIR", dir.as_os_str());
    }

    match command.spawn() {
        Ok((mut events, child)) => {
            let job = job_object::SidecarJobObject::create();
            if let Some(ref job_obj) = job {
                if !job_obj.assign_pid(child.pid()) {
                    eprintln!(
                        "[tafseer] warning: could not attach backend.exe (pid {}) to job object",
                        child.pid()
                    );
                }
            }
            // Read the stdout handshake (TAFSEER_SIDECAR_READY:port=XXXXX) with
            // a 30s timeout before draining the rest of the pipes.
            let (tx, rx) = mpsc::channel::<Option<u16>>();
            let tx_clone = tx.clone();
            tauri::async_runtime::spawn(async move {
                let mut port: Option<u16> = None;
                let deadline = Instant::now() + SIDECAR_HANDSHAKE_TIMEOUT;
                loop {
                    if port.is_some() || Instant::now() >= deadline {
                        break;
                    }
                    // Poll with a short timeout by awaiting recv with a timeout.
                    let recv = tokio::time::timeout(Duration::from_millis(200), events.recv()).await;
                    match recv {
                        Ok(Some(CommandEvent::Stdout(line))) => {
                            let text = String::from_utf8_lossy(&line);
                            eprintln!("[backend] {}", text.trim_end());
                            for raw_line in text.lines() {
                                if let Some(rest) = raw_line
                                    .trim()
                                    .strip_prefix("TAFSEER_SIDECAR_READY:port=")
                                {
                                    if let Ok(p) = rest.trim().parse::<u16>() {
                                        port = Some(p);
                                    }
                                }
                            }
                        }
                        Ok(Some(CommandEvent::Stderr(line))) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        Ok(Some(CommandEvent::Error(error))) => {
                            eprintln!("[backend] {error}");
                        }
                        Ok(Some(CommandEvent::Terminated(payload))) => {
                            eprintln!("[backend] exited (code: {:?})", payload.code);
                            break;
                        }
                        Ok(Some(_)) => {}
                        Ok(None) => break,
                        Err(_) => {} // timeout, loop again
                    }
                }
                let _ = tx_clone.send(port);
                // Continue draining so the child never blocks on a full pipe.
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Error(error) => eprintln!("[backend] {error}"),
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[backend] exited (code: {:?})", payload.code);
                            break;
                        }
                        _ => {}
                    }
                }
            });
            let port = rx
                .recv_timeout(SIDECAR_HANDSHAKE_TIMEOUT + Duration::from_secs(1))
                .ok()
                .flatten();
            (Some(child), job, port)
        }
        Err(error) => {
            eprintln!(
                "[tafseer] could not start {} ({error}); \
                 falling back to 127.0.0.1:{FALLBACK_SIDECAR_PORT}",
                executable.display()
            );
            (None, None, None)
        }
    }
}

/// Terminate the sidecar once, if it is still running. Idempotent.
fn stop_sidecar(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    let child = state
        .child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(child) = child {
        let pid = child.pid();
        match child.kill() {
            Ok(()) => eprintln!("[tafseer] stopped backend.exe (pid {pid})"),
            Err(error) => eprintln!("[tafseer] failed to stop backend.exe (pid {pid}): {error}"),
        }
    }
    // Dropping the Job Object handle closes the final reference and tears down
    // any lingering FFmpeg/worker child processes in the sidecar tree.
    let _ = state
        .job_object
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
}

/// Bring the main window back from the tray.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Tray "Stop tasks & quit": reuse the same close dialog when work is running
/// so the user makes the same explicit choice, otherwise quit immediately.
fn request_quit(app: &tauri::AppHandle) {
    let jobs = app
        .try_state::<SidecarState>()
        .map(|state| state.running_jobs.load(Ordering::SeqCst))
        .unwrap_or(0);
    show_main_window(app);
    if jobs > 0 {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            let _ = window.emit("app://close-requested", jobs);
        }
    } else {
        stop_sidecar(app);
        app.exit(0);
    }
}

/// Grant filesystem scope for a user-selected project folder on any drive.
#[tauri::command]
fn grant_project_folder_scope(app: tauri::AppHandle, folder_path: String) -> Result<(), String> {
    let path = PathBuf::from(&folder_path);
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    let scope = app.fs_scope();
    scope.allow_directory(&path, true).map_err(|e| e.to_string())?;
    Ok(())
}

fn nearest_canonical_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = path.parent();
    while let Some(dir) = current {
        if let Ok(canon) = std::fs::canonicalize(dir) {
            return Some(canon);
        }
        current = dir.parent();
    }
    None
}

fn is_under_allowed_base(app: &tauri::AppHandle, target: &Path) -> bool {
    let Some(ancestor) = nearest_canonical_ancestor(target) else {
        return false;
    };
    let candidates = [
        Some(local_app_data_dir(app)),
        app.path().local_data_dir().ok(),
        app.path().app_data_dir().ok(),
        app.path().data_dir().ok(),
        app.path().config_dir().ok(),
        app.path().home_dir().ok(),
        app.path().document_dir().ok(),
    ];
    candidates
        .into_iter()
        .flatten()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| ancestor.starts_with(root))
}

fn validate_atomic_project_path(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Project file path must be absolute".to_string());
    }
    if path.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err("Parent directory traversal is not permitted in project paths".to_string());
    }
    let ext_ok = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("tafseer"));
    if !ext_ok {
        return Err("Atomic project writes are limited to .tafseer files".to_string());
    }
    if app.fs_scope().is_allowed(path) || is_under_allowed_base(app, path) {
        return Ok(());
    }
    Err(format!(
        "Access denied: {} is outside the allowed project scope",
        path.display()
    ))
}

fn atomic_replace_bytes(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Target path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Target path has no file name".to_string())?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = parent.join(format!(
        ".{file_name}.tmp.{}.{nanos}",
        std::process::id()
    ));

    let write_res = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(err);
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let src_wide: Vec<u16> = tmp_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let dst_wide: Vec<u16> = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: Both buffers are NUL-terminated UTF-16 paths pointing to valid stack allocations.
        let ok = unsafe {
            MoveFileExW(
                src_wide.as_ptr(),
                dst_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("Atomic replace failed: {err}"));
        }
    }

    #[cfg(not(windows))]
    {
        if let Err(err) = std::fs::rename(&tmp_path, target) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("Atomic replace failed: {err}"));
        }
    }

    Ok(())
}

fn atomic_replace_file(target: &Path, contents: &str) -> Result<(), String> {
    atomic_replace_bytes(target, contents.as_bytes())
}

const MAX_CLIPBOARD_ASSET_BYTES: usize = 50 * 1024 * 1024;

fn sanitize_asset_project_id(project_id: &str) -> String {
    let cleaned: String = project_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned
    }
}

fn normalize_asset_extension(extension: &str) -> Result<&'static str, String> {
    match extension.trim().trim_start_matches('.').to_ascii_lowercase().as_str() {
        "png" => Ok("png"),
        "jpg" | "jpeg" => Ok("jpg"),
        "webp" => Ok("webp"),
        other => Err(format!("Unsupported clipboard image format: {other}")),
    }
}

fn save_clipboard_asset_to_root(
    base_dir: &Path,
    project_id: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Clipboard image is empty".to_string());
    }
    if bytes.len() > MAX_CLIPBOARD_ASSET_BYTES {
        return Err("Clipboard image exceeds the 50 MB limit".to_string());
    }
    let ext = normalize_asset_extension(extension)?;
    let safe_project = sanitize_asset_project_id(project_id);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let target = base_dir
        .join("assets")
        .join(safe_project)
        .join(format!("paste-{nanos}-{}.{ext}", std::process::id()));
    atomic_replace_bytes(&target, bytes)?;
    target
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Saved asset path is not valid UTF-8".to_string())
}

/// Save raw pasted image bytes into `%LOCALAPPDATA%\Tafseer Clipper\assets\<projectId>/`.
#[tauri::command]
fn save_clipboard_asset(
    app: tauri::AppHandle,
    project_id: String,
    extension: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let root = local_app_data_dir(&app).join("Tafseer Clipper");
    save_clipboard_asset_to_root(&root, &project_id, &extension, &bytes)
}

#[cfg(windows)]
fn read_clipboard_hdrop_paths() -> Result<Vec<String>, String> {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn OpenClipboard(hwnd_new_owner: *mut core::ffi::c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(format: u32) -> *mut core::ffi::c_void;
    }
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn DragQueryFileW(
            hdrop: *mut core::ffi::c_void,
            i_file: u32,
            lpsz_file: *mut u16,
            cch: u32,
        ) -> u32;
    }
    const CF_HDROP: u32 = 15;
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            // SAFETY: Paired with a successful `OpenClipboard` call.
            unsafe {
                CloseClipboard();
            }
        }
    }
    // SAFETY: `null_mut()` opens the clipboard for the current task.
    if unsafe { OpenClipboard(core::ptr::null_mut()) } == 0 {
        return Ok(Vec::new());
    }
    let _guard = ClipboardGuard;
    // SAFETY: Clipboard is open; `CF_HDROP` returns an HDROP handle when files are copied.
    let hdrop = unsafe { GetClipboardData(CF_HDROP) };
    if hdrop.is_null() {
        return Ok(Vec::new());
    }
    // SAFETY: `u32::MAX` with null buffer queries the dropped file count.
    let count = unsafe { DragQueryFileW(hdrop, u32::MAX, core::ptr::null_mut(), 0) };
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        // SAFETY: Null buffer queries UTF-16 character length excluding NUL.
        let len = unsafe { DragQueryFileW(hdrop, index, core::ptr::null_mut(), 0) };
        if len == 0 {
            continue;
        }
        let mut buf = vec![0u16; (len as usize) + 1];
        // SAFETY: `buf` has capacity `len + 1` UTF-16 code units.
        let copied = unsafe { DragQueryFileW(hdrop, index, buf.as_mut_ptr(), len + 1) };
        if copied > 0 {
            paths.push(String::from_utf16_lossy(&buf[..copied as usize]));
        }
    }
    Ok(paths)
}

#[cfg(not(windows))]
fn read_clipboard_hdrop_paths() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

/// Read copied Explorer file paths (CF_HDROP) on Ctrl+V in the desktop app.
#[tauri::command]
fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    read_clipboard_hdrop_paths()
}

/// Write a `.tafseer` snapshot via a sibling temp file, fsync, and atomic replace.
#[tauri::command]
fn write_project_file_atomic(
    app: tauri::AppHandle,
    path: String,
    contents: String,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    validate_atomic_project_path(&app, &target)?;
    atomic_replace_file(&target, &contents)
}

/// Renderer → shell: how many tasks are running. Drives the close dialog and
/// the tray tooltip; cheap enough to call on every job transition.
#[tauri::command]
fn set_running_jobs(app: tauri::AppHandle, count: usize) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    state.running_jobs.store(count, Ordering::SeqCst);
    let tooltip = if count == 0 {
        "Tafseer Clipper".to_string()
    } else {
        format!(
            "Tafseer Clipper — {count} task{} running",
            if count == 1 { "" } else { "s" }
        )
    };
    let tray = state
        .tray
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(tray) = tray.as_ref() {
        let _ = tray.set_tooltip(Some(tooltip.as_str()));
    }
}

/// Close dialog → shell: stop every task and exit.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    stop_sidecar(&app);
    app.exit(0);
}

/// Close dialog → shell: keep tasks alive with the window hidden in the tray.
#[tauri::command]
fn minimize_to_tray(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            acceleration::acceleration_status,
            acceleration::download_acceleration_pack,
            grant_project_folder_scope,
            write_project_file_atomic,
            save_clipboard_asset,
            read_clipboard_file_paths,
            secrets::protect_secret,
            secrets::unprotect_secret,
            set_running_jobs,
            quit_app,
            minimize_to_tray
        ])
        .setup(|app| {
            let paths = sidecar_paths(app.handle());
            let _ = std::fs::create_dir_all(&paths.fonts_dir);
            let _ = std::fs::create_dir_all(&paths.work_dir);

            // An installed GPU acceleration pack is handed to the sidecar as
            // TAFSEER_CUDA_DIR; an invalid marker is ignored (CPU fallback).
            let cuda_dir = acceleration::installed_cuda_dir(app.handle());
            let (mut child, mut job_object, negotiated_port) =
                spawn_sidecar(app.handle(), &paths, cuda_dir.as_deref());
            if child.is_some() && negotiated_port.is_none() {
                eprintln!(
                    "[tafseer] the sidecar started but never announced its port; \
                     stopping hung process and falling back to 127.0.0.1:{FALLBACK_SIDECAR_PORT}"
                );
                if let Some(hung) = child.take() {
                    let _ = hung.kill();
                }
                job_object.take();
            }
            let port = negotiated_port.unwrap_or(FALLBACK_SIDECAR_PORT);
            let sidecar_url = format!("http://127.0.0.1:{port}");

            // A tray icon is the "keep running" affordance: closing with active
            // tasks can hide the window here while the sidecar finishes them.
            let show = tauri::menu::MenuItem::with_id(
                app,
                "show",
                "Show window",
                true,
                None::<&str>,
            )?;
            let quit = tauri::menu::MenuItem::with_id(
                app,
                "quit",
                "Stop tasks & quit",
                true,
                None::<&str>,
            )?;
            let menu = tauri::menu::Menu::with_items(app, &[&show, &quit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("tauri.conf.json must declare a window icon")?;
            let tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("Tafseer Clipper")
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => request_quit(app),
                    _ => {}
                })
                .build(app.handle())?;

            // Managed before the window loads so an early `set_running_jobs`
            // call from the renderer always finds the state.
            app.manage(SidecarState {
                child: Mutex::new(child),
                job_object: Mutex::new(job_object),
                tray: Mutex::new(Some(tray)),
                running_jobs: AtomicUsize::new(0),
            });

            // The window is declared in `tauri.conf.json` with `create: false`
            // so it can be built here with the initialization script that
            // carries the resolved sidecar URL.
            let window_config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("tauri.conf.json must declare the main window")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)
                .map_err(|error| format!("could not prepare the main window: {error}"))?
                .initialization_script(initialization_script(&sidecar_url))
                .build()
                .map_err(|error| format!("could not create the main webview window: {error}"))?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // Only intercept when there is work to lose; the renderer
                    // then asks whether to stop it or keep it in the tray.
                    let jobs = window
                        .app_handle()
                        .try_state::<SidecarState>()
                        .map(|state| state.running_jobs.load(Ordering::SeqCst))
                        .unwrap_or(0);
                    if jobs > 0 {
                        api.prevent_close();
                        let _ = window.emit("app://close-requested", jobs);
                    }
                }
                WindowEvent::Destroyed => stop_sidecar(window.app_handle()),
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Tafseer Clipper shell");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            stop_sidecar(app_handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{atomic_replace_file, save_clipboard_asset_to_root};

    #[test]
    fn atomic_replace_creates_and_overwrites_without_temp_leftovers() {
        let dir = std::env::temp_dir().join(format!(
            "tafseer-atomic-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let target = dir.join("nested").join("project.tafseer");

        atomic_replace_file(&target, "{\"v\":1}").expect("initial atomic write");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"v\":1}");

        atomic_replace_file(&target, "{\"v\":2}").expect("overwrite atomic write");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"v\":2}");

        let leftovers: Vec<_> = std::fs::read_dir(target.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty(), "unexpected temp files left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_clipboard_asset_validates_extension_empty_and_sanitizes_project_id() {
        let dir = std::env::temp_dir().join(format!(
            "tafseer-clipboard-asset-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);

        assert!(save_clipboard_asset_to_root(&dir, "proj-1", "png", &[]).is_err());
        assert!(save_clipboard_asset_to_root(&dir, "proj-1", "exe", b"MZ").is_err());

        let saved = save_clipboard_asset_to_root(&dir, "../../evil/proj_1", "PNG", b"\x89PNG\r\n")
            .expect("valid png write");
        let saved_path = std::path::Path::new(&saved);
        assert!(saved_path.is_file());
        assert!(saved_path.starts_with(dir.join("assets").join("evilproj_1")));
        assert_eq!(saved_path.extension().and_then(|e| e.to_str()), Some("png"));
        assert_eq!(std::fs::read(saved_path).unwrap(), b"\x89PNG\r\n");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
