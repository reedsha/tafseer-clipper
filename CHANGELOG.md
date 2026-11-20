# Changelog

All notable changes to Tafseer Clipper are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions are **not** edited by hand. They are managed by
[Release Please](https://github.com/googleapis/release-please): merge a
Conventional Commit into `main`, and a `chore(release): vX.Y.Z` pull request
appears that bumps every version anchor and regenerates this file. Merging that
pull request creates the `vX.Y.Z` tag and starts the Windows release build.

## [0.2.3-beta](https://github.com/reedsha/tafseer-clipper/compare/v0.2.2-beta...v0.2.3-beta) (2026-11-20)


### Bug Fixes

* start the sidecar without uvicorn fd so the packaged engine stays online ([cce1b39](https://github.com/reedsha/tafseer-clipper/commit/cce1b39d15214694ed653fcea00acc47196a53ca))

## [0.2.2-beta](https://github.com/reedsha/tafseer-clipper/compare/v0.2.1-beta...v0.2.2-beta) (2026-11-20)


### Bug Fixes

* remediate audited defects across Quran integrity, desktop shell, subtitles and CI ([541231f](https://github.com/reedsha/tafseer-clipper/commit/541231f7f2dc37e6d24037d290560d5bd2429ad9))

## [0.2.1-beta](https://github.com/reedsha/tafseer-clipper/compare/v0.2.0-beta...v0.2.1-beta) (2026-11-19)


### Bug Fixes

* close the Steps 1-3 audit defects across ingest, discovery and subtitles ([#51](https://github.com/reedsha/tafseer-clipper/issues/51)) ([4d8d615](https://github.com/reedsha/tafseer-clipper/commit/4d8d615af4e6f5f176104f62d07f29608576c9ff))

## [0.2.0-beta](https://github.com/reedsha/tafseer-clipper/compare/v0.1.6-beta...v0.2.0-beta) (2026-11-19)


### Features

* add task center, session shell and localized settings (0.2.0) ([#49](https://github.com/reedsha/tafseer-clipper/issues/49)) ([0a0dcc7](https://github.com/reedsha/tafseer-clipper/commit/0a0dcc73a6c9b4730c0cf7a9de88fbe71e9d375c))

## [0.1.6-beta](https://github.com/reedsha/tafseer-clipper/compare/v0.1.5-beta...v0.1.6-beta) (2026-11-18)


### Features

* allow a separate Arabic verification model ([0746d7d](https://github.com/reedsha/tafseer-clipper/commit/0746d7d5f13049e17c699dff2aefed6c2e013da4))
* make clip finding explicit and configurable ([34d7224](https://github.com/reedsha/tafseer-clipper/commit/34d722496ba734bb5c021e09777b2a87b620ba95))


### Bug Fixes

* write the accel manifest without a UTF-8 BOM ([be981c6](https://github.com/reedsha/tafseer-clipper/commit/be981c6b51d55b86e5110dcd04afcca490fe23e6))


### Miscellaneous Chores

* pin release version ([90f39fe](https://github.com/reedsha/tafseer-clipper/commit/90f39fe68d55485b03228fcedda223de0e237e09))

## [0.1.5-beta](https://github.com/reedsha/tafseer-clipper/compare/v0.1.4-beta...v0.1.5-beta) (2026-11-18)


### Features

* add an explicit no-session start screen ([2610b13](https://github.com/reedsha/tafseer-clipper/commit/2610b13d2cca08bbff80fadd8d1fe17678d52a62))

## [0.1.4-beta](https://github.com/reedsha/tafseer-clipper/compare/v0.1.3-beta...v0.1.4-beta) (2026-11-18)


### Bug Fixes

* ship the engine as an onedir bundle so first launch has no false engine error ([13e76e2](https://github.com/reedsha/tafseer-clipper/commit/13e76e2e9671c33db35266e446418f16c3f4e456))

## [0.1.3-beta](https://github.com/reedsha/tafseer-clipper/compare/v0.1.2-beta...v0.1.3-beta) (2026-11-17)


### Bug Fixes

* align updater signing key and correct release readiness status ([2fb68e9](https://github.com/reedsha/tafseer-clipper/commit/2fb68e936870850f18074b23044db723e4c89c60))

## [0.1.2-beta](https://github.com/reedsha/tafseer-clipper/compare/v0.1.1-beta...v0.1.2-beta) (2026-11-17)


### Bug Fixes

* stop blaming signing when the update feed is unavailable ([e96e519](https://github.com/reedsha/tafseer-clipper/commit/e96e519caf22a5fba5f1fa44bca765043dec6c23))

## [0.1.1-beta](https://github.com/reedsha/tafseer-clipper/compare/v0.1.0-beta...v0.1.1-beta) (2026-11-17)


### Bug Fixes

* correct first-launch engine and model state ([fd77add](https://github.com/reedsha/tafseer-clipper/commit/fd77add5715472f08672e042ab891c44539cd785))

## [0.1.0-beta](https://github.com/reedsha/tafseer-clipper/compare/v0.1.0...v0.1.0-beta) (2026-11-17)


### Features

* adopt scissors-and-book brand mark ([c698501](https://github.com/reedsha/tafseer-clipper/commit/c698501709ae1b77d65b1e189a31da97d85e50ec))
* **backend:** add the optional System One decision tier ([a24a371](https://github.com/reedsha/tafseer-clipper/commit/a24a3711d8b9d4ad4b4680f53bb5439fe575ecfb))
* **backend:** support both decision wire formats without hostname guessing ([fd5e682](https://github.com/reedsha/tafseer-clipper/commit/fd5e68232dde8659cbc5273793f5f16ae483f7ae))
* regroup the settings drawer by wizard stage ([b4787ee](https://github.com/reedsha/tafseer-clipper/commit/b4787ee6462c2dc7364764fc469228f558369166))
* **ui:** add startup splash and apply the brand identity mark ([#28](https://github.com/reedsha/tafseer-clipper/issues/28)) ([7d0657e](https://github.com/reedsha/tafseer-clipper/commit/7d0657e3b5c309c9f7bd2aa5930fdd7e373fc00f))
* **ui:** rebuild the wizard shell for non-technical editors ([7767887](https://github.com/reedsha/tafseer-clipper/commit/77678879a9237a722420dd0f5d69c7df9e791a56))


### Bug Fixes

* **backend:** send the System One criteria and answer shapes providers accept ([06e43f3](https://github.com/reedsha/tafseer-clipper/commit/06e43f3be3fb4052aa2d44b737045083a14b50a2))
* fall back to CPU when GPU inference fails, and license the project under MIT ([#17](https://github.com/reedsha/tafseer-clipper/issues/17)) ([158062d](https://github.com/reedsha/tafseer-clipper/commit/158062d12c4243f18800c7963fa22dba2b236436))
* harden the decision tier probe, answer calibration and verify-all cleanup ([e5dc3c4](https://github.com/reedsha/tafseer-clipper/commit/e5dc3c434ebce722c0b53d94c49e4cfc103405dc))
* integrate the workspace and settings fix corpora ([80c163c](https://github.com/reedsha/tafseer-clipper/commit/80c163c15d0dd4e0621c080d79134fc7137edffc))
* probe the CUDA libraries instead of a dummy model ([#23](https://github.com/reedsha/tafseer-clipper/issues/23)) ([2fde33c](https://github.com/reedsha/tafseer-clipper/commit/2fde33c97aa72d5f54fec87c72c80185640e6728))


### Miscellaneous Chores

* release 0.1.0-beta ([81e6e0c](https://github.com/reedsha/tafseer-clipper/commit/81e6e0c0fa833bad4b72e4f68d6f74ad62614d7c))

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
