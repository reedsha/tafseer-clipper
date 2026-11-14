# Changelog

All notable changes to Tafseer Clipper are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions are **not** edited by hand. They are managed by
[Release Please](https://github.com/googleapis/release-please): merge a
Conventional Commit into `main`, and a `chore(release): vX.Y.Z` pull request
appears that bumps every version anchor and regenerates this file. Merging that
pull request creates the `vX.Y.Z` tag and starts the Windows release build.

## [0.1.0]

Initial release.

### Added

- Tauri v2 desktop shell (window lifecycle, FastAPI sidecar spawn, native file
  dialogs, scoped `.tafseer` project access, signed auto-updater).
- FastAPI sidecar: audio extraction, local transcription, clip discovery,
  Arabic verification, font import and batch rendering with SSE progress.
- Four-step wizard: Upload, Find Clips, Subtitles, Export.
- Bilingual Thai/Arabic subtitle studio with dual-style `.ass` burn-in.
- Optional GPU acceleration pack (CUDA runtime + cuDNN) with SHA-256
  verification and an explicit CPU fallback.
- Per-user NSIS installer with Authenticode signing hook.
