# Changelog

All notable changes to this project will be documented in this file.

## [0.2.3] - 2026-02-26

### Added
- add prompt-file flag for local prompt markdown

### Changed
- enforce package identity in tag workflow
- clarify purpose and usage

## [0.2.2] - 2026-02-25

### Fixed
- initialize changelog arrays under nounset

## [0.2.1] - 2026-02-25

### Added
- add codex-style release notes flow

### Fixed
- require --preid for pre* actions

## [0.2.0] - 2026-02-25

### Added
- add tag-driven release automation and changelog tooling
- add shared review gpt cli

### Fixed
- restore review launcher executable bit

### Changed
- split draft driver and add release/test tooling
- remove oracle runtime and unify prompt flag
- prepare npm publish metadata

## [0.1.0] - 2026-02-25

### Added
- Added the shared `@cobuild/review-gpt` CLI package used across Cobuild repositories.
- Added release tooling and tests for core prompt/draft behavior.

### Changed
- Removed Oracle runtime; the launcher now runs draft-only flow with manual submit.
- Unified custom inline prompt input under `--prompt`.
- Split draft staging CDP logic into a dedicated JS driver module.

### Fixed
- Restored executable mode for the review launcher script.
