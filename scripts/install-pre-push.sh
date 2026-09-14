#!/bin/sh
# Install the repo pre-push hook. No-op when this package is a dependency,
# a git worktree without a hooks dir, or not a git checkout.
if [ -n "$INIT_CWD" ] && [ "$INIT_CWD" != "$PWD" ]; then
  exit 0
fi
dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
[ -d "$dir/hooks" ] || exit 0
cp "$(dirname "$0")/pre-push.sh" "$dir/hooks/pre-push" && chmod +x "$dir/hooks/pre-push"
