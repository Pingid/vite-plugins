#!/usr/bin/env bash
set -e

# 1. Inspect lines sent over stdin to see if 'main' is being pushed
# Format: <local ref> <local sha1> <remote ref> <remote sha1>
IS_MAIN_PUSH=false

while read -r local_ref local_sha remote_ref remote_sha; do
  if [ "$local_ref" = "refs/heads/main" ] || [ "$remote_ref" = "refs/heads/main" ]; then
    IS_MAIN_PUSH=true
    break
  fi
done

if [ "$IS_MAIN_PUSH" = false ]; then
  exit 0
fi

# 2. Prevent infinite recursion when this hook executes 'git push'
if [ "$PRE_PUSH_RUNNING" = "1" ]; then
  exit 0
fi
export PRE_PUSH_RUNNING=1

WT_DIR=".temp/wt"

# 3. Cleanup function on exit (success or failure)
cleanup() {
  git worktree remove --force "$WT_DIR" 2>/dev/null || rm -rf "$WT_DIR"
  git worktree prune 2>/dev/null || true
}
trap cleanup EXIT

# 4. Self-healing pre-cleanup: clear stale locks/folders from past crashes
git worktree prune 2>/dev/null || true
if [ -d "$WT_DIR" ]; then
  git worktree remove --force "$WT_DIR" 2>/dev/null || rm -rf "$WT_DIR"
fi

echo "Pre-push: Preparing pkg worktree and building..."

# Ensure target branch exists locally from remote, or create orphan if missing
if ! git show-ref --verify --quiet refs/heads/pkg; then
  git branch pkg origin/pkg 2>/dev/null || git branch pkg main
fi

git worktree add "$WT_DIR" pkg

# 5. Build, commit, and push inside an isolated subshell
(
  cd "$WT_DIR"
  git reset --hard main
  # Worktree .git is a file; skip lifecycle so postinstall cannot touch hooks.
  pnpm install --ignore-scripts
  pnpm build
  git add -f dist
  git commit -m "transpile"
  git push origin pkg -f
)