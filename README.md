# suit

Multi-harness AI agent configurator. Suit up your harness with outfits and modes — one tool for Claude Code, Codex, Gemini CLI, GitHub Copilot, APM, and Pi.

## Status

**v0.5.0** — adds `suit up` / `suit off` / `suit current` for project-state mutation alongside the existing stateless launcher. See [ADR-0012](docs/adr/0012-suit-up-and-suit-off.md).

**v0.4.0** — major composition-model rename: persona → outfit, with new accessory primitive and mode-include-block. See [CHANGELOG](CHANGELOG.md).

**v0.3.0** — dropped legacy path support (`~/.config/agent-config/`, `.agent-config/`).

## Install

```bash
npm install -g @agent-ops/suit
```

This puts two binaries on your PATH:
- `suit` — the runtime launcher.
- `suit-build` — the build helper (used internally by `suit` for Codex/Copilot prelaunch; rarely invoked directly).

## Quick start

```bash
# Install
npm install -g @agent-ops/suit

# Point at any suit-compatible content repo
suit init https://github.com/your-username/your-config

# Discover what's available
suit list outfits
suit list modes
suit list accessories

# Inspect the current state
suit status

# Two ways of working — pick the one that fits your session:

# 1. Stateless launcher — wraps the harness for one session, then cleans up.
#    Right answer for: "try this outfit for one query."
suit claude --outfit backend --mode focused
suit codex --outfit backend --accessory tracing --accessory pr-policy

# 2. Project-state mutator — dresses the project so native invocations
#    (claude, codex, pi from your shell or IDE) inherit the suit.
#    Right answer for: "wear this for the next few hours of work."
suit up --outfit backend --mode focused      # writes .claude/, .codex/, .pi/, .suit/lock.json
claude                                       # native; picks up the dressed config
codex --skip-git-repo-check
pi --provider openrouter
suit current                                 # inspect what's applied
suit off                                     # remove everything suit applied

# suit up without flags (on a TTY) drops into an interactive picker.
suit up

# Pull updates from the content repo whenever you want
suit sync
```

Pass-through arguments work after `--`:

```bash
suit claude --outfit backend -- --resume sess-123
```

To bypass filtering for one invocation:

```bash
suit claude --no-filter
```

For a more detailed walkthrough — including content tier resolution, authoring, and troubleshooting — see [USAGE.md](docs/USAGE.md).

## Dev mode (point at a local content repo)

If you're maintaining a content repo locally and want suit to read from it without cloning into `~/.local/share/suit/content/`:

```bash
export SUIT_CONTENT_PATH=~/projects/your-config
suit list outfits
suit claude --outfit backend
```

`SUIT_CONTENT_PATH` overrides the default cloned-content location for the current shell.

## How it works

`suit` reads YAML-frontmatter outfit and mode definitions, computes a per-session resolution (which skills to keep, which to drop, what mode prompt to inject), then prelaunches the target harness with a filtered view of `~/.<harness>/` mirrored to a tempdir. Your real `~/.<harness>/` is never modified.

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
SUIT_CONTENT_PATH=~/projects/agent-config suit list outfits
```

`npm link` is required to use `suit` and `suit-build` together — the runtime invokes `suit-build` via PATH for Codex/Copilot prelaunch. Without `npm link` (or `npm install -g`), those subcommands will fail with `ENOENT: spawn suit-build`.

## License

MIT
