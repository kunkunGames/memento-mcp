#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOURCE_DIR_DEFAULT="$REPO_ROOT"
ORIGIN_URL_DEFAULT="https://github.com/kunkunGames/memento-mcp.git"
UPSTREAM_URL_DEFAULT="https://github.com/JinHo-von-Choi/memento-mcp.git"

SOURCE_DIR="$SOURCE_DIR_DEFAULT"
ORIGIN_URL="$ORIGIN_URL_DEFAULT"
UPSTREAM_URL="$UPSTREAM_URL_DEFAULT"
PULL_MAIN=1

usage() {
  cat <<'EOF'
Usage: bootstrap-memento-mcp-source.sh [options]

Options:
  --source-dir PATH     Canonical clone path
  --origin-url URL      Fork remote URL
  --upstream-url URL    Upstream remote URL
  --skip-pull           Do not pull origin/main after bootstrap
  --help                Show this help
EOF
}

log() {
  printf '[bootstrap-memento-mcp-source] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dir)
      SOURCE_DIR="${2:?missing value for --source-dir}"
      shift 2
      ;;
    --origin-url)
      ORIGIN_URL="${2:?missing value for --origin-url}"
      shift 2
      ;;
    --upstream-url)
      UPSTREAM_URL="${2:?missing value for --upstream-url}"
      shift 2
      ;;
    --skip-pull)
      PULL_MAIN=0
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

need_cmd git

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  mkdir -p "$(dirname "$SOURCE_DIR")"
  log "Cloning fork into $SOURCE_DIR"
  git clone "$ORIGIN_URL" "$SOURCE_DIR"
else
  log "Source clone already exists: $SOURCE_DIR"
fi

git -C "$SOURCE_DIR" remote set-url origin "$ORIGIN_URL"
if git -C "$SOURCE_DIR" remote get-url upstream >/dev/null 2>&1; then
  git -C "$SOURCE_DIR" remote set-url upstream "$UPSTREAM_URL"
else
  git -C "$SOURCE_DIR" remote add upstream "$UPSTREAM_URL"
fi

if [[ "$PULL_MAIN" -eq 1 ]]; then
  current_branch="$(git -C "$SOURCE_DIR" branch --show-current)"
  dirty_count="$(git -C "$SOURCE_DIR" status --porcelain | wc -l | tr -d ' ')"
  if [[ "$current_branch" == "main" && "$dirty_count" == "0" ]]; then
    log "Pulling origin/main"
    git -C "$SOURCE_DIR" pull --ff-only origin main
  else
    log "Skipping pull because branch=$current_branch dirty_count=$dirty_count"
  fi
fi

log "Remotes:"
git -C "$SOURCE_DIR" remote -v

log "Status:"
git -C "$SOURCE_DIR" status --short --branch
