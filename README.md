# @cobuild/review-gpt

Shared `review:gpt` launcher used across Cobuild repositories.

## Usage

```bash
cobuild-review-gpt --config scripts/review-gpt.config.sh --preset security
cobuild-review-gpt --config scripts/review-gpt.config.sh --prompt "Focus on callback auth and griefing"
```

The config file is a sourced shell file that can override defaults, preset mappings, and path settings.

## Release

This package is published as `@cobuild/review-gpt` (npm `@cobuild` scope).

```bash
pnpm run release:check
pnpm run release:patch
# or: pnpm run release:minor
# or: pnpm run release:major
```

The release script:
- requires a clean git working tree on `main`
- verifies npm auth and package scope (`@cobuild/review-gpt`)
- bumps version (commit + tag), publishes to npm, and pushes `main` + tags
