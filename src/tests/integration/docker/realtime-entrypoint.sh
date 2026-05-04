#!/usr/bin/env bash
# realtime-entrypoint.sh — interactive container init for the suit
# realtime e2e test harness.
#
# Responsibilities:
#   1. Copy host-mounted credentials from /host-auth/ into writable
#      locations in the container HOME. We copy (not symlink/bind) so the
#      harnesses can refresh OAuth tokens without touching host files.
#   2. Re-export the Claude OAuth token as CLAUDE_CODE_OAUTH_TOKEN. Recent
#      Claude Code versions reject OAuth read directly from the
#      credentials file when invoked with --print; the API path requires
#      the env var. Pattern from run-real-local.sh.
#   3. Verify SUIT_CONTENT_PATH points at a readable content repo.
#   4. Print a cheatsheet, then exec the requested CMD (default: bash).

set -euo pipefail

cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# --- 1. Copy host auth into HOME -------------------------------------------
if [[ -d /host-auth ]]; then
  cyan "[init] copying host auth from /host-auth/ → \$HOME"
  cp -rL /host-auth/.claude       "$HOME/" 2>/dev/null || true
  cp -L  /host-auth/.claude.json  "$HOME/" 2>/dev/null || true
  cp -rL /host-auth/.codex        "$HOME/" 2>/dev/null || true
  # Make sure copied dirs are writable by the container user.
  chmod -R u+rwX "$HOME/.claude" "$HOME/.codex" 2>/dev/null || true
fi

# --- 2. Extract Claude OAuth token to env var ------------------------------
CRED_FILE="$HOME/.claude/.credentials.json"
if [[ -f "$CRED_FILE" ]]; then
  if command -v jq >/dev/null 2>&1; then
    TOKEN="$(jq -r '.claudeAiOauth.accessToken // empty' "$CRED_FILE" 2>/dev/null || true)"
    if [[ -n "$TOKEN" ]]; then
      export CLAUDE_CODE_OAUTH_TOKEN="$TOKEN"
      green "[init] CLAUDE_CODE_OAUTH_TOKEN exported (Claude --print path)"
    fi
  fi
fi

# --- 3. Validate auth signals ----------------------------------------------
auth_status() {
  local label="$1" ok="$2"
  if [[ "$ok" == "ok" ]]; then green "  ✓ $label"; else yellow "  ⚠ $label (no auth detected)"; fi
}

CLAUDE_OK="";   [[ -n "${ANTHROPIC_API_KEY:-}" || -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" || -f "$HOME/.claude/.credentials.json" || -f "$HOME/.claude.json" ]] && CLAUDE_OK=ok
CODEX_OK="";    [[ -n "${OPENAI_API_KEY:-}" || -f "$HOME/.codex/auth.json" ]] && CODEX_OK=ok
PI_OK="";       [[ -n "${OPENROUTER_API_KEY:-}" || -n "${ANTHROPIC_API_KEY:-}" ]] && PI_OK=ok

# --- 4. Validate content repo ----------------------------------------------
CONTENT_OK=""
if [[ -n "${SUIT_CONTENT_PATH:-}" && -d "$SUIT_CONTENT_PATH" ]]; then
  CONTENT_OK=ok
fi

# --- 5. Cheatsheet ---------------------------------------------------------
cat <<EOF

$(cyan '═══ suit realtime e2e ═════════════════════════════════════════════')

  cwd:       $(pwd)
  suit:      $(suit --help >/dev/null 2>&1 && command -v suit || echo MISSING)
  content:   ${SUIT_CONTENT_PATH:-<unset>}  $( [[ "$CONTENT_OK" == "ok" ]] && echo "(✓ readable)" || echo "(⚠ missing)" )

$(cyan 'auth presence:')
$(auth_status "claude  (ANTHROPIC_API_KEY | CLAUDE_CODE_OAUTH_TOKEN | ~/.claude/.credentials.json)" "$CLAUDE_OK")
$(auth_status "codex   (OPENAI_API_KEY    | ~/.codex/auth.json)"                                    "$CODEX_OK")
$(auth_status "pi      (OPENROUTER_API_KEY | ANTHROPIC_API_KEY)"                                    "$PI_OK")

$(cyan 'try:')
  suit status
  suit list personas
  suit list modes
  suit show persona backend
  suit doctor

  # apply suits — these spawn the real harness against a prelaunch tempdir
  suit claude --persona backend --mode focused -- --print "say hi"
  suit codex  --persona backend --mode code    -- exec --skip-git-repo-check "say hi"
  suit pi     --persona personal --mode design -- --provider openrouter --print "say hi"

  # codex requires --skip-git-repo-check because the suit prelaunch tempdir
  # is not a git repo. pi needs --provider openrouter to use the Doppler key.

  # inspect what was emitted (set by suit prelaunch in each session)
  # use --verbose on any suit invocation to see the tempdir path

$(cyan '═══════════════════════════════════════════════════════════════════')

EOF

if [[ -z "$CONTENT_OK" ]]; then
  red "[init] SUIT_CONTENT_PATH is unset or not a directory."
  red "       Bind-mount your content repo and set the env var."
fi

# --- 6. Hand off -----------------------------------------------------------
exec "$@"
