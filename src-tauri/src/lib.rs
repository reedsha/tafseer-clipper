//! Tauri v2 desktop shell for Tafseer Clipper.
//!
//! Per `AGENTS.md` §3 the Rust side owns exactly five things:
//! the window lifecycle, spawning/pinging the Python sidecar, injecting the
//! renderer's boot configuration, terminating the sidecar on exit, and
//! provisioning the optional GPU acceleration pack. Every piece of application
//! logic lives in the React renderer and in the FastAPI sidecar — nothing here
//! does business work.

mod acceleration;

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{Manager, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Window label declared in `tauri.conf.json` and targeted by the capability.
const MAIN_WINDOW_LABEL: &str = "main";

/// The bundled sidecar binary name. Tauri resolves this against
/// `bundle.externalBin` (`binaries/backend`) next to the executable, so the
/// argument must be the configured name without the `-$TARGET_TRIPLE` suffix.
const SIDECAR_PROGRAM: &str = "backend";

/// Port used when the sidecar cannot be spawned (for example a dev run where
/// `backend.exe` is missing) so a manually started backend still answers.
const FALLBACK_SIDECAR_PORT: u16 = 8008;

/// Process-wide handle to the spawned sidecar.
struct SidecarState {
    /// `None` when spawning failed; the renderer then talks to the fallback port.
    child: Mutex<Option<CommandChild>>,
}

/// Writable, user-scoped directories handed to `backend.exe` through the
/// environment. Keeping them under `%LOCALAPPDATA%` means imported fonts and
/// job files survive reinstalls and are writable in packaged builds.
struct SidecarPaths {
    fonts_dir: PathBuf,
    work_dir: PathBuf,
}

/// Ask the OS for a free loopback port by binding `127.0.0.1:0`, reading the
/// assigned port, and immediately releasing it for the sidecar to claim.
fn pick_free_loopback_port() -> Option<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    drop(listener);
    Some(port)
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

/// Spawn `backend.exe` with the loopback port, user-data directories and the
/// optional GPU acceleration pack directory.
/// Returns `None` (and never panics) when the binary is missing or fails to
/// start, so the app can fall back to a manually launched backend.
fn spawn_sidecar(
    app: &tauri::AppHandle,
    port: u16,
    paths: &SidecarPaths,
    cuda_dir: Option<&Path>,
) -> Option<CommandChild> {
    let command = match app.shell().sidecar(SIDECAR_PROGRAM) {
        Ok(command) => command,
        Err(error) => {
            eprintln!(
                "[tafseer] could not resolve the {SIDECAR_PROGRAM} sidecar ({error}); \
                 falling back to 127.0.0.1:{FALLBACK_SIDECAR_PORT}"
            );
            return None;
        }
    };

    let mut command = command
        .env("TAFSEER_HOST", "127.0.0.1")
        .env("TAFSEER_PORT", port.to_string())
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
            // Drain stdout/stderr so the child never blocks on a full pipe.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&line));
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
            Some(child)
        }
        Err(error) => {
            eprintln!(
                "[tafseer] could not start {SIDECAR_PROGRAM}.exe ({error}); \
                 falling back to 127.0.0.1:{FALLBACK_SIDECAR_PORT}"
            );
            None
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
            acceleration::download_acceleration_pack
        ])
        .setup(|app| {
            let paths = sidecar_paths(app.handle());
            let _ = std::fs::create_dir_all(&paths.fonts_dir);
            let _ = std::fs::create_dir_all(&paths.work_dir);

            let port = pick_free_loopback_port().unwrap_or(FALLBACK_SIDECAR_PORT);
            // An installed GPU acceleration pack is handed to the sidecar as
            // TAFSEER_CUDA_DIR; an invalid marker is ignored (CPU fallback).
            let cuda_dir = acceleration::installed_cuda_dir(app.handle());
            let child = spawn_sidecar(app.handle(), port, &paths, cuda_dir.as_deref());
            let sidecar_url = if child.is_some() {
                format!("http://127.0.0.1:{port}")
            } else {
                format!("http://127.0.0.1:{FALLBACK_SIDECAR_PORT}")
            };
            app.manage(SidecarState {
                child: Mutex::new(child),
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
            if matches!(event, WindowEvent::Destroyed) && window.label() == MAIN_WINDOW_LABEL {
                stop_sidecar(window.app_handle());
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
