# Docker Test Harness

Two complementary modes live in this directory:

1. **Test matrix** (`Dockerfile` + `test-runner.sh` + `scenarios/*.sh`) —
   automated stub-mode + real-mode regression matrix across 4 harnesses.
2. **Realtime e2e** (`Dockerfile.realtime` + `run-realtime.sh` +
   `realtime-entrypoint.sh`) — interactive shell in a clean container with
   the three core harnesses (claude / codex / pi) installed, suit linked
   from local source, and live host credentials piped in. Use this when
   you want to *poke* at how a suit applies, not just assert it does.

> **NOTE:** The matrix is not currently exercised by `npm test`. It needs
> a separate fixture content repo to run end-to-end. Realtime mode reads
> from any local content repo via `--content=` (default
> `~/projects/agent-config`).

---

## Realtime e2e (`run-realtime.sh`)

Interactive `bash` inside a container with:

- Only `claude-code`, `codex`, and `pi` CLIs installed (npm-global).
- No baked-in `~/.claude`, `~/.codex`, `~/.pi/` — fresh user dir at start.
- `suit` and `suit-build` linked from `/workspace` at build time
  (the local source tree, not npm).
- Credentials piped in from host:
  - **Claude OAuth** ← macOS Keychain (`Claude Code-credentials`).
    Re-exported as `CLAUDE_CODE_OAUTH_TOKEN` because Claude Code's
    `--print` mode rejects OAuth read directly from the credentials file.
  - **Codex OAuth + config** ← `~/.codex/{auth.json,config.toml}`.
  - **`OPENROUTER_API_KEY`** ← Doppler (`global/prd` by default).
- Content repo bind-mounted at `/content` and exported as
  `SUIT_CONTENT_PATH=/content`.

Build + run:

```bash
# build only
docker build -f src/tests/integration/docker/Dockerfile.realtime -t suit-realtime .

# build + drop into interactive bash
src/tests/integration/docker/run-realtime.sh

# skip rebuild
src/tests/integration/docker/run-realtime.sh --no-build

# different content repo
src/tests/integration/docker/run-realtime.sh --content=/path/to/your/agent-config

# bind-mount /workspace from host so source edits show up immediately
# (requires host node_modules + dist to be built)
src/tests/integration/docker/run-realtime.sh --live-source

# non-interactive smoke battery
src/tests/integration/docker/run-realtime.sh --no-build -- bash -c '
  suit status &&
  suit claude --persona backend --mode focused -- --print "say PONG" &&
  suit codex  --persona backend --mode code    -- exec --skip-git-repo-check "say PONG" &&
  suit pi     --persona personal --mode design -- --provider openrouter --print "say PONG"
'
```

Harness gotchas:

- **codex** refuses to run outside a git repo by default. The suit
  prelaunch tempdir is not a git repo, so add `--skip-git-repo-check`
  after `exec`.
- **pi** needs `--provider openrouter` to use `OPENROUTER_API_KEY`
  (otherwise it tries Anthropic).
- **claude** uses `CLAUDE_CODE_OAUTH_TOKEN` (env) for `--print` mode.

---

## Test matrix (`Dockerfile` + `test-runner.sh`)

End-to-end test scaffold that exercises `ac` against all 4 real harness CLIs inside a clean Docker environment.

## What it tests

5 scenarios × 4 harnesses = 20 scenarios total.

| # | Scenario | What it verifies |
|---|---|---|
| 01 | no-flags | `AC_WRAPPED=1` set; `AC_RESOLUTION_PATH` unset |
| 02 | persona-only | `--persona backend` sets a readable resolution JSON with `persona=backend` |
| 03 | mode-only | `--mode focused` sets resolution JSON with `mode=focused` and non-empty `mode_prompt` |
| 04 | persona-and-mode | Both persona and mode are reflected in the resolution JSON |
| 05 | no-filter | `--no-filter` bypasses resolution; `AC_RESOLUTION_PATH` unset |

Harnesses: `claude`, `codex`, `gemini`, `pi`.

If an API key env var is absent, all scenarios for that harness print `SKIP` (not `FAIL`).

## Build

Run from repo root so the Dockerfile can `COPY . /workspace`:

```bash
docker build \
  -f src/tests/integration/docker/Dockerfile \
  -t agent-config-test \
  .
```

Build time: ~3–5 min (npm installs 4 harness CLIs).  
No API keys are needed at build time.

## Run (full matrix)

```bash
docker run --rm \
  -e ANTHROPIC_API_KEY \
  -e OPENAI_API_KEY \
  -e GEMINI_API_KEY \
  agent-config-test
```

Env vars are forwarded from the host shell. Omit any key to skip that harness.

## Run (single harness)

```bash
docker run --rm -e ANTHROPIC_API_KEY agent-config-test claude
docker run --rm -e OPENAI_API_KEY agent-config-test codex
docker run --rm -e GEMINI_API_KEY agent-config-test gemini
docker run --rm -e ANTHROPIC_API_KEY agent-config-test pi
```

## Dry run (no API calls)

```bash
docker run --rm agent-config-test --dry-run
```

Prints the test plan without executing any scenarios or calling any APIs.

## Cost estimate

Scenarios use stub harness shims for env-plumbing tests — they do **not** call the LLM APIs.  
Estimated cost per full run with real API calls: **~$0.00** (stubs only; no real prompts sent).  
If you modify scenarios to use real harness invocations, budget ~$0.04 per full run.

## Harness auth notes

| Harness | Key var | Notes |
|---|---|---|
| Claude Code | `ANTHROPIC_API_KEY` | passed via env |
| Codex | `OPENAI_API_KEY` | `codex login` not needed when key is in env |
| Gemini CLI | `GEMINI_API_KEY` | passed via env |
| Pi | `ANTHROPIC_API_KEY` | same key as Claude; `--provider anthropic` implied |

## Running a single scenario script

Each scenario script is self-contained and accepts the harness name as `$1`:

```bash
bash src/tests/integration/docker/scenarios/02-persona-only.sh claude
```

Requires `tsx` and `ac.ts` on the expected paths (`/workspace/...` inside Docker,  
or adjust `WORKSPACE` env var for local runs).
