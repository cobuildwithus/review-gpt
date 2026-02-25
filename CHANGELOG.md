# Changelog

All notable changes to this project will be documented in this file.

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
