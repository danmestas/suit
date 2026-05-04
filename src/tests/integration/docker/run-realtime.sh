#!/usr/bin/env bash
# run-realtime.sh — host-side launcher for the suit realtime e2e
# Docker container.
#
# Pulls credentials from your local environment so the in-container
# harnesses are authenticated:
#   - Claude Code OAuth      ← macOS Keychain ('Claude Code-credentials')
#   - Codex OAuth + config   ← ~/.codex/auth.json + ~/.codex/config.toml
#   - OpenRouter API key     ← Doppler (project=global, config=prd)
#
# Mounts:
#   - /workspace/...   ← suit source (so npm link in the image points at HEAD)
#   - /host-auth/      ← ephemeral tempdir holding copied credentials
#   - /content         ← your local wardrobe (SUIT_CONTENT_PATH)
#
# Usage:
#   run-realtime.sh                        # interactive bash, default content
#   run-realtime.sh --content=/path/to/cfg # override content repo
#   run-realtime.sh --no-build             # skip docker build
#   run-realtime.sh --live-source          # bind-mount host /workspace
#                                          #   (faster iteration, but requires
#                                          #    dist/ + node_modules built locally)
#   run-realtime.sh -- bash -c "suit status && suit list outfits"
#
# Anything after `--` is passed through as the container CMD.

set -euo pipefail

cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# Resolve repo root (two parents up from this script).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../../.." &>/dev/null && pwd)"

# --- args ------------------------------------------------------------------
CONTENT_DIR="${SUIT_CONTENT_PATH_HOST:-$HOME/projects/wardrobe}"
DO_BUILD=1
LIVE_SOURCE=0
DOPPLER_PROJECT="${DOPPLER_PROJECT:-global}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-prd}"
IMAGE_TAG="suit-realtime:latest"
PASSTHRU_CMD=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --content=*)        CONTENT_DIR="${1#*=}"; shift ;;
    --image=*)          IMAGE_TAG="${1#*=}"; shift ;;
    --doppler-project=*) DOPPLER_PROJECT="${1#*=}"; shift ;;
    --doppler-config=*)  DOPPLER_CONFIG="${1#*=}"; shift ;;
    --no-build)         DO_BUILD=0; shift ;;
    --live-source)      LIVE_SOURCE=1; shift ;;
    --) shift; PASSTHRU_CMD=("$@"); break ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) red "unknown arg: $1"; exit 2 ;;
  esac
done

# --- preflight -------------------------------------------------------------
command -v docker  >/dev/null || { red "docker not found";  exit 1; }
command -v security >/dev/null || { red "security (macOS keychain CLI) not found — Linux users should set CLAUDE_CODE_OAUTH_TOKEN manually"; exit 1; }
command -v doppler >/dev/null || { red "doppler not found"; exit 1; }

if [[ ! -d "$CONTENT_DIR" ]]; then
  red "content dir not found: $CONTENT_DIR"
  red "pass --content=/path/to/your/wardrobe or set SUIT_CONTENT_PATH_HOST"
  exit 1
fi

# --- stage host-auth tempdir ----------------------------------------------
TMP_AUTH="$(mktemp -d -t suit-realtime-auth.XXXXXX)"
trap 'rm -rf "$TMP_AUTH"' EXIT

cyan "[stage] tempdir: $TMP_AUTH"

# Claude OAuth from Keychain
mkdir -p "$TMP_AUTH/.claude"
CLAUDE_KEYCHAIN_BLOB="$(security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null || true)"
if [[ -n "$CLAUDE_KEYCHAIN_BLOB" ]]; then
  # The keychain blob IS the JSON contents of .credentials.json.
  printf '%s\n' "$CLAUDE_KEYCHAIN_BLOB" > "$TMP_AUTH/.claude/.credentials.json"
  chmod 600 "$TMP_AUTH/.claude/.credentials.json"
  green "[stage] Claude OAuth → host-auth/.claude/.credentials.json"
else
  yellow "[stage] no Claude keychain entry (claude will run unauth'd unless ANTHROPIC_API_KEY is set)"
fi

# Mirror ~/.claude.json (Claude Code per-user state file) if present.
if [[ -f "$HOME/.claude.json" ]]; then
  cp -L "$HOME/.claude.json" "$TMP_AUTH/.claude.json"
fi

# Codex auth + config — file-based, no keychain extraction needed.
if [[ -d "$HOME/.codex" ]]; then
  mkdir -p "$TMP_AUTH/.codex"
  # Only copy files Codex actually needs to authenticate; skip the multi-GB
  # session log dirs so the bind-mount stays small.
  for f in auth.json config.toml; do
    [[ -f "$HOME/.codex/$f" ]] && cp -L "$HOME/.codex/$f" "$TMP_AUTH/.codex/$f"
  done
  if [[ -f "$TMP_AUTH/.codex/auth.json" ]]; then
    chmod 600 "$TMP_AUTH/.codex/auth.json"
    green "[stage] Codex auth → host-auth/.codex/auth.json"
  else
    yellow "[stage] no ~/.codex/auth.json (codex will run unauth'd unless OPENAI_API_KEY is set)"
  fi
fi

# OpenRouter from Doppler — gets piped through env, not file.
OPENROUTER_API_KEY="$(doppler secrets get OPENROUTER_API_KEY \
  --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || true)"
if [[ -n "$OPENROUTER_API_KEY" ]]; then
  green "[stage] OPENROUTER_API_KEY fetched from doppler ($DOPPLER_PROJECT/$DOPPLER_CONFIG)"
else
  yellow "[stage] doppler did not return OPENROUTER_API_KEY (pi will need ANTHROPIC_API_KEY fallback)"
fi

# --- build image ----------------------------------------------------------
if [[ "$DO_BUILD" == "1" ]]; then
  cyan "[build] $IMAGE_TAG (from $REPO_ROOT)"
  docker build \
    -f "$SCRIPT_DIR/Dockerfile.realtime" \
    -t "$IMAGE_TAG" \
    "$REPO_ROOT"
fi

# --- run -------------------------------------------------------------------
TTY_FLAGS="-i"
if [ -t 0 ] && [ -t 1 ]; then TTY_FLAGS="-it"; fi

RUN_ARGS=(
  --rm
  "$TTY_FLAGS"
  -v "$TMP_AUTH:/host-auth:ro"
  -v "$CONTENT_DIR:/content:ro"
  -e "SUIT_CONTENT_PATH=/content"
  -e "TERM=${TERM:-xterm-256color}"
)

if [[ "$LIVE_SOURCE" == "1" ]]; then
  if [[ ! -d "$REPO_ROOT/node_modules" || ! -d "$REPO_ROOT/dist" ]]; then
    red "[run] --live-source requires host node_modules/ and dist/ to exist"
    red "      run: (cd $REPO_ROOT && npm install && npm run build)"
    exit 1
  fi
  cyan "[run] live-source: bind-mounting $REPO_ROOT → /workspace (rw)"
  RUN_ARGS+=(-v "$REPO_ROOT:/workspace")
fi

# Forward env-var-style auth too — harmless if also mounted.
[[ -n "${ANTHROPIC_API_KEY:-}" ]]   && RUN_ARGS+=(-e "ANTHROPIC_API_KEY")
[[ -n "${OPENAI_API_KEY:-}" ]]      && RUN_ARGS+=(-e "OPENAI_API_KEY")
[[ -n "${OPENROUTER_API_KEY:-}" ]]  && RUN_ARGS+=(-e "OPENROUTER_API_KEY=$OPENROUTER_API_KEY")

cyan "[run] $IMAGE_TAG  cmd=${PASSTHRU_CMD[*]:-bash}"
exec docker run "${RUN_ARGS[@]}" "$IMAGE_TAG" "${PASSTHRU_CMD[@]:-bash}"
