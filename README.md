# suit

Multi-harness AI agent configurator. Suit up your harness with personas and modes — one tool for Claude Code, Codex, Gemini CLI, GitHub Copilot, APM, and Pi.

## Status

**v0.1.0** — first publishable release. Renamed extraction of the `ac` wrapper from [agent-config](https://github.com/danmestas/agent-config). Phase 1 of a multi-phase rollout. Phase 2 will add `suit init`, `suit sync`, and `suit status`.

## Install

```bash
npm install -g @agent-ops/suit
```

This puts two binaries on your PATH:
- `suit` — the runtime launcher.
- `suit-build` — the build helper (used internally by `suit` for Codex/Copilot prelaunch; rarely invoked directly).

## Quick start

`suit` needs to know where your content lives — a directory containing `personas/`, `modes/`, and `skills/`. In v0.1.0, you point it explicitly via the `SUIT_CONTENT_PATH` environment variable. Phase 2 will add `suit init` to clone a starter automatically.

```bash
# Point at a checked-out content repo:
export SUIT_CONTENT_PATH=~/projects/your-agent-config

# Discover what's available:
suit list personas
suit list modes

# Inspect a persona:
suit show persona backend

# Check that all harness binaries are installed:
suit doctor

# Launch a harness with a persona + mode applied:
suit claude --persona backend --mode focused
suit codex --persona backend --mode focused
suit gemini --persona frontend --mode design
suit copilot --persona personal
```

Pass-through arguments work after `--`:

```bash
suit claude --persona backend -- --resume sess-123
```

To bypass filtering for one invocation:

```bash
suit claude --no-filter
```

## Migration from `apm-builder`

If you used `ac` from the `agent-config` repo:

| Old | New |
|---|---|
| `ac claude --persona X` | `suit claude --persona X` |
| `apm-builder docs` | `suit-build docs` |
| `apm-builder.config.yaml` | `suit.config.yaml` |
| `npm install -g @agent-config/apm-builder` | `npm install -g @agent-ops/suit` |

**The config filename is renamed.** If you have an `apm-builder.config.yaml` in your content repo, rename it to `suit.config.yaml`. v0.1.0 does NOT read the legacy filename — it will be silently ignored.

## How it works

`suit` reads YAML-frontmatter persona and mode definitions, computes a per-session resolution (which skills to keep, which to drop, what mode prompt to inject), then prelaunches the target harness with a filtered view of `~/.<harness>/` mirrored to a tempdir. Your real `~/.<harness>/` is never modified.

For Codex and Copilot (which read `AGENTS.md` and `copilot-instructions.md` from the project root), `suit` invokes `suit-build docs` to generate filtered markdown into a tempdir and runs the harness with that as the working directory.

## Development

```bash
git clone https://github.com/danmestas/suit.git
cd suit
npm install
npm run build       # tsc + postbuild (shebangs + import rewriter)
npm link            # exposes `suit` and `suit-build` globally
npm test            # vitest

# Dogfood against an external content repo:
SUIT_CONTENT_PATH=~/projects/agent-config suit list personas
```

`npm link` is required to use `suit` and `suit-build` together — the runtime invokes `suit-build` via PATH for Codex/Copilot prelaunch. Without `npm link` (or `npm install -g`), those subcommands will fail with `ENOENT: spawn suit-build`.

## Known limitations (v0.1.0)

- **No `suit init`** — content discovery is manual via `SUIT_CONTENT_PATH`. Coming in Phase 2.
- **No `--help`** — bare `suit` prints usage; full help is in this README. Coming in Phase 2.
- **3 tests fail in standalone repo** — they require `TAXONOMY.md` from a content repo. Documented in `KNOWN-FAILURES.md`. Will be addressed with content fixtures in Phase 2.

## License

MIT
