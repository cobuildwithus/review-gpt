#!/usr/bin/env bash
set -euo pipefail

export COBUILD_COMMITTER_EXAMPLE='fix(review-gpt): tighten selector fallback'
export COBUILD_RELEASE_PACKAGE_NAME='@cobuild/review-gpt'
export COBUILD_RELEASE_REPOSITORY_URL='git+https://github.com/cobuildwithus/review-gpt.git'
export COBUILD_RELEASE_COMMIT_TEMPLATE='release: v%s'
export COBUILD_RELEASE_TAG_MESSAGE_TEMPLATE='release: v%s'
export COBUILD_RELEASE_POST_PUSH_CMD='./scripts/sync-dependent-repos.sh --version "$COBUILD_RELEASE_VERSION" --wait-for-publish'
export COBUILD_RELEASE_POST_PUSH_SKIP_ENV='REVIEW_GPT_SKIP_UPSTREAM_SYNC'
