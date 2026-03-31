# Changelog

All notable changes to this project will be documented in this file.

## [0.5.11] - 2026-03-31

### Fixed
- drop artifact boilerplate and mute static wake label

## [0.5.10] - 2026-03-31

### Added
- default wake polling
- add wake polling
- stage repomix xml review artifacts

### Fixed
- handle generic thinking rows

### Changed
- use incur parsing directly

## [0.5.9] - 2026-03-30

### Added
- use repo-tools packager by default

### Fixed
- allow delayed `thread wake` follow-ups to poll until the ChatGPT thread no longer looks busy before downloading artifacts or resuming Codex

### Changed
- make polling the default `thread wake` behavior and leave `--no-poll-until-complete` as the explicit one-shot opt-out

## [0.5.8] - 2026-03-30

### Added
- add explicit test include flags

## [0.5.7] - 2026-03-29

### Fixed
- detect zip attachments in delayed follow-ups
- refresh stale chat tabs before capture

## [0.5.6] - 2026-03-29

### Fixed
- resolve codex binary outside shell path

## [0.5.5] - 2026-03-29

### Fixed
- pack tarball outside workspace tree

## [0.5.4] - 2026-03-29

### Fixed
- defer browser access until delay elapses

### Changed
- reset metadata to v0.5.2

## [0.5.2] - 2026-03-29

### Added
- add delayed chatgpt wake helpers

## [0.5.1] - 2026-03-26

### Fixed
- honor composer chip state

## [Unreleased]

### Changed
- depend on `@cobuild/repo-tools` at runtime so `review-gpt` can package repo context without a consumer repo wrapper by default
- attach `repo.repomix.xml` before `repo.snapshot.zip` and append `BASE_COMMIT` review guidance by default
- remove legacy argv rewriting and use incur parsing directly for review and thread subcommands

### Fixed
- stop hanging on ChatGPT's current Pro picker flow when the dropdown button label stays `ChatGPT` and the composer chip reflects the selected model instead

## [0.5.0] - 2026-03-26

### Added
- rebuild review-gpt on incur

### Fixed
- retain selection promises during draft staging

## [0.4.4] - 2026-03-26

### Fixed
- sanitize deep research reports
- clarify wait behavior

## [0.4.3] - 2026-03-26

### Fixed
- capture completed Deep Research reports from the sandbox when they do not mirror back into the parent conversation turn
- wait up to 60 seconds for Deep Research to auto-start after send before falling back to the second-step `Start` gate

## [0.4.2] - 2026-03-25

### Fixed
- detect trailing picker selection icons

## [0.4.1] - 2026-03-24

### Fixed
- accept compact pro model labels

## [0.4.0] - 2026-03-24

### Added
- add deep research response capture
- add zip:src script

## [0.3.2] - 2026-03-13

### Fixed
- initialize preset arrays for strict bash

## [0.3.1] - 2026-03-13

### Changed
- No user-facing changes recorded.

## [0.3.0] - 2026-03-13

### Added
- require repo-defined review prompts
- support repo-defined presets

## [0.2.16] - 2026-03-13

### Added
- expand managed browser options

### Changed
- drop manual copy fallback
- bump repo-tools to v0.1.13
- remove repo-tools fallback shim
- align pnpm review workflow

## [0.2.15] - 2026-03-07

### Changed
- bump repo-tools to 0.1.10
- remove npm lockfile

## [0.2.14] - 2026-03-07

### Fixed
- invoke package script via bash

### Changed
- reuse repo-tools sync helper
- align repo-tools lockfile
- bump repo-tools to 0.1.8
- use published repo-tools 0.1.6
- bump repo-tools
- remove local repo-tools workaround

## [0.2.13] - 2026-03-06

### Fixed
- use installed repo-tools package

## [0.2.12] - 2026-03-06

### Fixed
- harden chatgpt attachment staging

### Changed
- allow repo-local non-conventional commits
- use published repo-tools
- share repo tooling

## [0.2.11] - 2026-03-05

### Changed
- remove startup1 wording

## [0.2.10] - 2026-03-05

### Added
- sync canonical downstream wrappers
- add repo harness and safer model defaults

### Changed
- remove startup-specific wrapper sync
- ignore audit-packages directory
- auto-sync startup repos after release

## [0.2.9] - 2026-03-04

### Fixed
- harden autosend for existing chat targets

## [0.2.8] - 2026-03-04

### Added
- add send/chat targeting for review GPT drafts

## [0.2.7] - 2026-02-26

### Changed
- fix no-zip draft staging under bash nounset

## [0.2.6] - 2026-02-26

### Added
- add optional --no-zip prompt-only draft mode

## [0.2.5] - 2026-02-26

### Changed
- No user-facing changes recorded.

## [0.2.4] - 2026-02-26

### Fixed
- tolerate selector misses and retry socket drops

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
