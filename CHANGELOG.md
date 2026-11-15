# Changelog

All notable changes to Tafseer Clipper are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions are **not** edited by hand. They are managed by
[Release Please](https://github.com/googleapis/release-please): merge a
Conventional Commit into `main`, and a `chore(release): vX.Y.Z` pull request
appears that bumps every version anchor and regenerates this file. Merging that
pull request creates the `vX.Y.Z` tag and starts the Windows release build.

## [0.2.0](https://github.com/reedsha/tafseer-clipper/compare/v0.1.0...v0.2.0) (2026-11-15)


### Features

* **ui:** add startup splash and apply the brand identity mark ([#28](https://github.com/reedsha/tafseer-clipper/issues/28)) ([7d0657e](https://github.com/reedsha/tafseer-clipper/commit/7d0657e3b5c309c9f7bd2aa5930fdd7e373fc00f))


### Bug Fixes

* fall back to CPU when GPU inference fails, and license the project under MIT ([#17](https://github.com/reedsha/tafseer-clipper/issues/17)) ([158062d](https://github.com/reedsha/tafseer-clipper/commit/158062d12c4243f18800c7963fa22dba2b236436))
* integrate the workspace and settings fix corpora ([80c163c](https://github.com/reedsha/tafseer-clipper/commit/80c163c15d0dd4e0621c080d79134fc7137edffc))
* probe the CUDA libraries instead of a dummy model ([#23](https://github.com/reedsha/tafseer-clipper/issues/23)) ([2fde33c](https://github.com/reedsha/tafseer-clipper/commit/2fde33c97aa72d5f54fec87c72c80185640e6728))

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
