# Release Checklist — v0.1.0 (packaged end-to-end gate)

Run this against the **installed** application on a clean Windows 11 VM with no
Python, Node, Rust or system FFmpeg installed. Attach the completed checklist to
the release PR/issue.

## 0. Artifact integrity

- [ ] Installer installs per-user without an administrator prompt.
- [ ] `signtool verify /pa /v "<installer>.exe"` reports a valid Authenticode signature and timestamp.
- [ ] Installer file name matches the tag (`Tafseer Clipper_0.1.0_x64-setup.exe`).
- [ ] App version shows `0.1.0` in Settings → Storage (Updates) and `GET /health`.
- [ ] `THIRD_PARTY_NOTICES.md` is present in the install directory (`resources/`).

## 1. Launch and shell plumbing

- [ ] App opens at 1280×800 (min 1024×700), branded icon in the taskbar/Start menu.
- [ ] Header sidecar pill turns **online** within ~30 s on first launch; tooltip shows version, GPU/CPU state and the accelerator name (hardware names only here, not in the main UI).
- [ ] `%LOCALAPPDATA%\Tafseer Clipper\logs\sidecar.log` exists and contains the startup paths.
- [ ] Closing the window leaves no `backend.exe` / `ffmpeg.exe` running (Task Manager).
- [ ] Re-opening the app starts a new sidecar on a free port (no 8008 collision if another process owns 8008).
- [ ] `%LOCALAPPDATA%\Tafseer Clipper\fonts` and `...\work` are created and writable.

## 1b. GPU acceleration pack (optional, NVIDIA)

- [ ] On a machine **without** an NVIDIA GPU: Settings → GPU acceleration shows "CPU only", no download button, and transcription/export still work (CPU fallback). No GPU product-line names or VRAM-capacity wording appear anywhere in the UI.
- [ ] On a machine **with** an NVIDIA GPU but no CUDA runtime: Settings and Step 1 show "GPU detected — runtime not installed" with an **Enable GPU acceleration** button; the download shows size/progress and a restart prompt.
- [ ] The pack lands in `%LOCALAPPDATA%\Tafseer Clipper\accel\<version>\` with `current.json`, and every file's SHA-256 matches the manifest.
- [ ] Corrupting one DLL then re-running the download fails with a readable error and leaves no half-installed runtime (sidecar still starts on CPU).
- [ ] After restart, `/health.acceleration.transcription` = `gpu` and transcription uses the GPU; unplugging/disabling the GPU or breaking the driver returns the app to CPU without blocking Step 1.
- [ ] Deleting `%LOCALAPPDATA%\Tafseer Clipper\accel` and restarting returns to CPU mode cleanly.

## 2. Step 1 — Ingest

- [ ] Drag-and-drop a real `.mp4` lecture returns an absolute path (native drop) and Step 1 accepts it.
- [ ] "Browse" opens the native Windows file dialog (no browser `<input type=file>` fallback).
- [ ] First local transcription downloads the Whisper model with visible progress/status and does not appear frozen.
- [ ] On a GPU-enabled machine: local `int8` transcription uses the GPU (`/health.acceleration.transcription` = `gpu`, `whisper.device` = `cuda`).
- [ ] On a machine **without** the GPU pack: transcription falls back to CPU with a visible "CPU (slower)" state instead of failing the step.
- [ ] Transcription completes; duration/segment count match the lecture; glossary replacements applied.
- [ ] Cancel during transcription leaves no orphan `ffmpeg.exe`; error is actionable.
- [ ] Settings → AI Providers: `[Test Connection]` reaches the configured provider and reports the resolved model; a bad key shows the provider's error.
- [ ] Prompt preset selection/editing persists across restart.

## 3. Step 2 — Find Clips

- [ ] Discovery returns clips for a 1–3 h lecture, including proposals from the **first** part of the lecture (not just the tail).
- [ ] Approve / re-roll: approved intervals are excluded from the next run.
- [ ] Waveform renders without a multi-second freeze (precomputed peaks; 3 h WAV).
- [ ] Video player seeks, plays, and `J/K/L` shuttle changes the playback rate (rate readout visible); `←/→` nudge 0.2 s.
- [ ] Cut buffer (+0.3 s) is applied to approved clips.

## 4. Step 3 — Subtitles

- [ ] 9:16 blur-fill preview shows the real video frame (blurred backdrop + contained foreground); center-crop mode differs.
- [ ] Imported `.ttf`/`.otf` font appears in the preview typography (FontFace), not a fallback system font.
- [ ] Thai auto-wrap respects Max Characters Per Line; long captions break instead of overflowing.
- [ ] `Ctrl+Enter` splits at the cursor into two cues with split text and timing (no duplicated text).
- [ ] Verify Quran / Fix Arabic round-trips through the provider; failures are actionable.
- [ ] Harakat padding, box opacity and per-line outline colour change **both** preview and burned output.
- [ ] Safe-zone guides show TikTok/Reels glyphs in 9:16 and hide in 16:9.

## 5. Step 4 — Export

- [ ] Queue rows show per-clip resolution + framing + sanitized filename; Windows reserved names (`CON`, `PRN`, …) are prefixed.
- [ ] Render with hardware encoding on a GPU machine: progress animates forward (NumberFlow), per-clip bars complete, counters never over/under-count.
- [ ] Force CPU fallback (disable the GPU / no NVENC available): the fallback is reported once and the batch completes on `libx264`.
- [ ] Output MP4 plays with burned-in dual-style subtitles, correct fonts, no clipped Harakat, correct aspect ratio.
- [ ] `.srt` sidecars are written when enabled; `.ass` job files are in the work dir.
- [ ] Filename template tokens (`{LectureName}`, `{Clip}`, `{Title}`, `{Resolution}`) match the queue preview exactly.
- [ ] Cancel mid-batch stops FFmpeg within a few seconds; no orphan `ffmpeg.exe`.
- [ ] Killing `backend.exe` mid-batch shows "Render interrupted" (not an infinite spinner), and the app can restart the sidecar.
- [ ] Switching wizard steps during a render keeps the batch running; returning to Step 4 shows live progress.

## 6. Persistence and resume

- [ ] Auto-save writes a `.tafseer` snapshot to the project folder (default `<appLocalDataDir>/projects`, or Settings → Storage → Project folder).
- [ ] Restarting the app and resuming from Recent restores step, clips and subtitles.
- [ ] Resuming after a sidecar restart does **not** require re-transcription (transcripts persisted on disk).
- [ ] Replacing the lecture clears old subtitle tracks; Recent entries do not multiply.
- [ ] Settings (API keys, fonts, glossary, presets) survive restart; deleting all presets stays deleted after restart.

## 7. Updater

- [ ] Settings → Storage → Updates shows the current version and "Check for updates".
- [ ] With a newer `latest.json` published, the check offers the update, downloads it, installs and relaunches into the new version.
- [ ] Updater signature verification works (tampered artifact is rejected).
- [ ] In a browser dev build the Updates section explains that updates are only available in the installed app.

## 8. Uninstall / reinstall

- [ ] Uninstall from Windows Settings removes program files; user data (`%LOCALAPPDATA%\Tafseer Clipper`) is preserved.
- [ ] Reinstall finds existing fonts/projects and works without reconfiguration.
- [ ] Uninstall leaves no running sidecar/ffmpeg processes and no firewall prompts.

## 9. Diagnostics

- [ ] Settings → Storage → "Copy diagnostics" copies a readable bundle (versions, paths, health JSON, platform).
- [ ] A failed autosave surfaces the `lastAutosaveError` warning row.

## Sign-off

| Field | Value |
|---|---|
| Version / tag | |
| Installer SHA-256 | |
| Signature verified | |
| Clean VM OS build | |
| GPU / driver | |
| Tester / date | |
| Known issues | |
