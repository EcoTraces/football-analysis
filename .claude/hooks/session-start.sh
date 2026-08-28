#!/bin/bash
set -euo pipefail

# Claude Code on the web clones this repo without the refs/remotes/origin/HEAD
# symref, so any command relying on it (e.g. /security-review's
# `git diff origin/HEAD...`) fails with "ambiguous argument 'origin/HEAD...':
# unknown revision or path not in the working tree." Ask the remote which
# branch is its default and record that locally — safe to re-run.
if [ -d "$CLAUDE_PROJECT_DIR/.git" ] && git -C "$CLAUDE_PROJECT_DIR" remote get-url origin >/dev/null 2>&1; then
  git -C "$CLAUDE_PROJECT_DIR" remote set-head origin -a >/dev/null 2>&1 || true
fi
