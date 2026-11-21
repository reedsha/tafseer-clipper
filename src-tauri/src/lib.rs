//! Tauri v2 desktop shell for Tafseer Clipper.
//!
//! Per `AGENTS.md` §3 the Rust side owns exactly five things:
//! the window lifecycle, spawning/pinging the Python sidecar, injecting the
//! renderer's boot configuration, terminating the sidecar on exit, and
//! provisioning the optional GPU acceleration pack. Every piece of application
//! logic lives in the React renderer and in the FastAPI sidecar — nothing here
//! does business work.

mod acceleration;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
) -> (Option<CommandChild>, Option<u16>) {
    let Some(executable) = sidecar_executable(app) else {
        eprintln!(
            "[tafseer] falling back to 127.0.0.1:{FALLBACK_SIDECAR_PORT}"
        );
        return (None, None);
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
            // Read the stdout handshake (TAFSEER_SIDECAR_READY:port=XXXXX) with
            // a 10s timeout before draining the rest of the pipes.
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
            (Some(child), port)
        }
        Err(error) => {
            eprintln!(
                "[tafseer] could not start {} ({error}); \
                 falling back to 127.0.0.1:{FALLBACK_SIDECAR_PORT}",
                executable.display()
            );
            (None, None)
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
            let (child, negotiated_port) = spawn_sidecar(app.handle(), &paths, cuda_dir.as_deref());
            if child.is_some() && negotiated_port.is_none() {
                eprintln!(
                    "[tafseer] the sidecar started but never announced its port; \
                     falling back to 127.0.0.1:{FALLBACK_SIDECAR_PORT}"
                );
            }
            let port = negotiated_port.unwrap_or(FALLBACK_SIDECAR_PORT);
            let sidecar_url = if child.is_some() {
                format!("http://127.0.0.1:{port}")
            } else {
                format!("http://127.0.0.1:{FALLBACK_SIDECAR_PORT}")
            };

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
