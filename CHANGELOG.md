# Changelog

All notable changes to this project will be documented in this file.

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
