#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOURCE_DIR_DEFAULT="$REPO_ROOT"
LIVE_DIR_DEFAULT="/Users/kunkun/.adk/release/services/memento-mcp"
PRESERVE_FILE_DEFAULT="$SCRIPT_DIR/memento-mcp-live-preserve.txt"
LAUNCHD_LABEL_DEFAULT="com.agentdesk.memento-mcp"
HEALTH_URL_DEFAULT="http://127.0.0.1:57332/health"

SOURCE_DIR="$SOURCE_DIR_DEFAULT"
LIVE_DIR="$LIVE_DIR_DEFAULT"
PRESERVE_FILE="$PRESERVE_FILE_DEFAULT"
LAUNCHD_LABEL="$LAUNCHD_LABEL_DEFAULT"
HEALTH_URL="$HEALTH_URL_DEFAULT"
DRY_RUN=0
RESTART_SERVICE=1
RUN_INSTALL_MODE="auto"
ALLOW_DIRTY_LIVE=0
PRUNE_REMOVED=1
INSTALL_REQUIRED=0

declare -a PRESERVE_PATTERNS=()

usage() {
  cat <<'EOF'
Usage: deploy-memento-mcp.sh [options]

Options:
  --source-dir PATH       Canonical source clone
  --live-dir PATH         Live runtime directory
  --preserve-file PATH    Glob list of live-local paths to preserve
  --label LABEL           launchd label to restart
  --health-url URL        HTTP health check URL
  --dry-run               Show actions without copying files
  --no-restart            Do not restart the live service
  --skip-install          Never sync npm dependencies in the live directory
  --force-install         Always run npm ci in the live directory
  --allow-dirty-live      Allow overwriting live tracked files even when they differ
  --no-prune              Do not remove tracked files missing from source
  --help                  Show this help
EOF
}

log() {
  printf '[deploy-memento-mcp] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

load_preserve_patterns() {
  local file="$1"
  PRESERVE_PATTERNS=()

  if [[ ! -f "$file" ]]; then
    return 0
  fi

  while IFS= read -r raw || [[ -n "$raw" ]]; do
    raw="${raw%%#*}"
    raw="${raw#"${raw%%[![:space:]]*}"}"
    raw="${raw%"${raw##*[![:space:]]}"}"
    [[ -z "$raw" ]] && continue
    PRESERVE_PATTERNS+=("$raw")
  done < "$file"
}

is_preserved_path() {
  local path="$1"
  local pattern
  for pattern in "${PRESERVE_PATTERNS[@]}"; do
    case "$path" in
      $pattern) return 0 ;;
    esac
  done
  return 1
}

filter_path_list() {
  local input="$1"
  local output="$2"

  : > "$output"
  while IFS= read -r path || [[ -n "$path" ]]; do
    [[ -z "$path" ]] && continue
    if is_preserved_path "$path"; then
      continue
    fi
    printf '%s\n' "$path" >> "$output"
  done < "$input"

  sort -u "$output" -o "$output"
}

print_list_with_prefix() {
  local prefix="$1"
  local file="$2"

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    log "$prefix$line"
  done < "$file"
}

live_path_matches_source() {
  local path="$1"
  local source_path="$SOURCE_DIR/$path"
  local live_path="$LIVE_DIR/$path"

  if [[ ! -e "$source_path" || ! -e "$live_path" ]]; then
    return 1
  fi

  cmp -s "$source_path" "$live_path"
}

should_run_install() {
  local install_needed=0
  local manifest

  if [[ "$RUN_INSTALL_MODE" == "force" ]]; then
    return 0
  fi

  if [[ "$RUN_INSTALL_MODE" == "never" ]]; then
    return 1
  fi

  if [[ ! -d "$LIVE_DIR/node_modules" ]]; then
    return 0
  fi

  for manifest in package.json package-lock.json npm-shrinkwrap.json; do
    if [[ -e "$SOURCE_DIR/$manifest" ]]; then
      if [[ ! -e "$LIVE_DIR/$manifest" ]] || ! cmp -s "$SOURCE_DIR/$manifest" "$LIVE_DIR/$manifest"; then
        install_needed=1
        break
      fi
    fi
  done

  [[ "$install_needed" -eq 1 ]]
}

restart_and_check() {
  local domain="gui/$(id -u)/$LAUNCHD_LABEL"
  local attempt

  log "Restarting $domain"
  launchctl kickstart -k "$domain"

  if [[ -z "$HEALTH_URL" ]]; then
    return 0
  fi

  log "Waiting for health check: $HEALTH_URL"
  for attempt in $(seq 1 20); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      log "Health check passed"
      return 0
    fi
    sleep 1
  done

  die "Health check failed after restart: $HEALTH_URL"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dir)
      SOURCE_DIR="${2:?missing value for --source-dir}"
      shift 2
      ;;
    --live-dir)
      LIVE_DIR="${2:?missing value for --live-dir}"
      shift 2
      ;;
    --preserve-file)
      PRESERVE_FILE="${2:?missing value for --preserve-file}"
      shift 2
      ;;
    --label)
      LAUNCHD_LABEL="${2:?missing value for --label}"
      shift 2
      ;;
    --health-url)
      HEALTH_URL="${2:?missing value for --health-url}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-restart)
      RESTART_SERVICE=0
      shift
      ;;
    --skip-install)
      RUN_INSTALL_MODE="never"
      shift
      ;;
    --force-install)
      RUN_INSTALL_MODE="force"
      shift
      ;;
    --allow-dirty-live)
      ALLOW_DIRTY_LIVE=1
      shift
      ;;
    --no-prune)
      PRUNE_REMOVED=0
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
need_cmd rsync
need_cmd cmp
need_cmd sort
need_cmd comm

if [[ "$RESTART_SERVICE" -eq 1 && "$DRY_RUN" -ne 1 ]]; then
  need_cmd launchctl
  if [[ -n "$HEALTH_URL" ]]; then
    need_cmd curl
  fi
fi

[[ -d "$SOURCE_DIR/.git" ]] || die "Source clone is not a git repo: $SOURCE_DIR"
[[ -d "$LIVE_DIR/.git" ]] || die "Live dir is not a git repo: $LIVE_DIR"

load_preserve_patterns "$PRESERVE_FILE"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

source_all="$tmpdir/source-all.txt"
live_all="$tmpdir/live-all.txt"
source_sync="$tmpdir/source-sync.txt"
live_sync="$tmpdir/live-sync.txt"
dirty_live="$tmpdir/dirty-live.txt"
dirty_conflicts="$tmpdir/dirty-conflicts.txt"
remove_list="$tmpdir/remove-list.txt"

git -C "$SOURCE_DIR" ls-files > "$source_all"
git -C "$LIVE_DIR" ls-files > "$live_all"
filter_path_list "$source_all" "$source_sync"
filter_path_list "$live_all" "$live_sync"

{
  git -C "$LIVE_DIR" diff --name-only
  git -C "$LIVE_DIR" diff --cached --name-only
} | sort -u > "$dirty_live"

: > "$dirty_conflicts"
while IFS= read -r path || [[ -n "$path" ]]; do
  [[ -z "$path" ]] && continue
  if is_preserved_path "$path"; then
    continue
  fi
  if live_path_matches_source "$path"; then
    continue
  fi
  printf '%s\n' "$path" >> "$dirty_conflicts"
done < "$dirty_live"

if [[ -s "$dirty_conflicts" && "$ALLOW_DIRTY_LIVE" -ne 1 ]]; then
  log "Live repo has tracked changes that differ from the source clone."
  print_list_with_prefix "dirty-live-conflict: " "$dirty_conflicts"
  die "Re-run with --allow-dirty-live after review, or preserve those paths."
fi

if should_run_install; then
  INSTALL_REQUIRED=1
fi

if [[ "$PRUNE_REMOVED" -eq 1 ]]; then
  comm -23 "$live_sync" "$source_sync" > "$remove_list"
else
  : > "$remove_list"
fi

log "Source clone: $SOURCE_DIR"
log "Live dir: $LIVE_DIR"
log "Preserve file: $PRESERVE_FILE"

if [[ ${#PRESERVE_PATTERNS[@]} -gt 0 ]]; then
  local_pattern_file="$tmpdir/preserve-patterns.txt"
  printf '%s\n' "${PRESERVE_PATTERNS[@]}" > "$local_pattern_file"
  print_list_with_prefix "preserve: " "$local_pattern_file"
fi

if [[ -s "$remove_list" ]]; then
  print_list_with_prefix "remove: " "$remove_list"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Dry-run sync preview"
  rsync -avn --files-from="$source_sync" "$SOURCE_DIR"/ "$LIVE_DIR"/
  if [[ "$INSTALL_REQUIRED" -eq 1 ]]; then
    log "would run: npm ci"
  fi
  if [[ "$RESTART_SERVICE" -eq 1 ]]; then
    log "would restart launchd label: $LAUNCHD_LABEL"
  fi
  exit 0
fi

if [[ -s "$remove_list" ]]; then
  while IFS= read -r path || [[ -n "$path" ]]; do
    [[ -z "$path" ]] && continue
    rm -f "$LIVE_DIR/$path"
  done < "$remove_list"
fi

rsync -a --files-from="$source_sync" "$SOURCE_DIR"/ "$LIVE_DIR"/

if [[ "$INSTALL_REQUIRED" -eq 1 ]]; then
  if [[ ! -f "$LIVE_DIR/package-lock.json" && ! -f "$LIVE_DIR/npm-shrinkwrap.json" ]]; then
    die "Deterministic deploy requires package-lock.json or npm-shrinkwrap.json in $LIVE_DIR"
  fi

  log "Running npm ci in $LIVE_DIR"
  (
    cd "$LIVE_DIR"
    npm ci
  )
else
  log "Skipping npm dependency sync"
fi

if [[ "$RESTART_SERVICE" -eq 1 ]]; then
  restart_and_check
else
  log "Skipping restart"
fi

log "Deploy complete"
