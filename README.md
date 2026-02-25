# @cobuild/review-gpt

Shared `review:gpt` launcher used across Cobuild repositories.

## Usage

```bash
cobuild-review-gpt --config scripts/review-gpt.config.sh --preset security
cobuild-review-gpt --config scripts/review-gpt.config.sh --prompt "Focus on callback auth and griefing"
```

The config file is a sourced shell file that can override defaults, preset mappings, and path settings.
