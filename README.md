# suit

Multi-harness AI agent configurator. Suit up your harness with outfits, cuts, and accessories — one tool for Claude Code, Codex, Gemini CLI, GitHub Copilot, APM, and Pi.

## Status

**v0.9.0** — vocabulary rename: `mode` → `cut`. Resolver semantics unchanged; clean break per [ADR-0016](docs/adr/0016-rename-mode-to-cut.md).

**v0.5.0** — adds `suit up` / `suit off` / `suit current` for project-state mutation alongside the existing stateless launcher. See [ADR-0012](docs/adr/0012-suit-up-and-suit-off.md).

**v0.4.0** — major composition-model rename: persona → outfit, with new accessory primitive. See [CHANGELOG](CHANGELOG.md).

**v0.3.0** — dropped legacy path support (`~/.config/agent-config/`, `.agent-config/`).

## Install

```bash
npm install -g @agent-ops/suit
```

This puts two binaries on your PATH:
- `suit` — the runtime launcher.
- `suit-build` — the build helper (used internally by `suit` for Codex/Copilot prelaunch; rarely invoked directly).

## Quick start

The standard workflow: `suit up` to dress the project, work with native harness CLIs, `suit off` when you're done.

```bash
# Install once
npm install -g @agent-ops/suit

# Point at any suit-compatible content repo (one-time setup per machine)
suit init https://github.com/your-username/your-config

# In any project, dress it with an outfit + cut (+ optional accessories):
cd ~/projects/foo
suit up --outfit backend --cut focused
# or, on a TTY, just `suit up` and pick from a numbered list

# Now use your harnesses normally — they pick up the dressed config:
claude                          # native invocation; inherits .claude/CLAUDE.md, skills, hooks
codex --skip-git-repo-check
pi --provider openrouter

# Inspect or remove when you're done:
suit current                    # shows applied resolution + file count + drift
suit off                        # cleanly removes everything suit applied

# Switch outfits in the same project: undress first, then redress.
suit off && suit up --outfit frontend --cut design
```

That's the daily-driver flow. For one-off "try this outfit for a single query without dressing the project" cases, the stateless launcher still works:

```bash
suit claude --outfit backend --cut focused -- --print "say hi"
suit codex --outfit backend --accessory tracing -- exec --skip-git-repo-check "say hi"
suit claude --no-filter                   # bypass filtering for one session
```

Discover what's available:

```bash
suit list outfits
suit list cuts
suit list accessories
suit status
suit sync                       # pull latest from your content repo
```

For the deeper walkthrough — content tier resolution, authoring, refuse-when-dirty semantics, drift detection — see [USAGE.md](docs/USAGE.md).

## Runtime injection (`suit inject`)

`suit inject` materializes a single wardrobe component into a harness home so a worker that's already running can pick it up — without restarting it. Where `suit up` dresses a whole project, `suit inject` adds one component to an existing harness home.

```bash
# Add one skill / hook / accessory to a harness home:
suit inject --skill release-watch  --home ~/projects/foo
suit inject --hook  rtk-suggest    --home ~/projects/foo
suit inject --accessory philosophy --home ~/projects/foo   # the accessory's declared components only

# --home defaults to $CLAUDE_PROJECT_DIR, else the cwd — so a hook running
# inside a worker can self-inject with no flag:
suit inject --skill release-watch
```

Exactly one of `--accessory` / `--bundle` / `--skill` / `--hook` is required. Injection is **scoped** — only the named component(s) are written, never the whole wardrobe. It's **idempotent** (re-injecting an unchanged component is a no-op) and **refuses to clobber** a hand-edited target unless `--force`.

Reload semantics differ by harness, and `suit inject` reports which applies (`reload: not-required | restart-required`):

- **claude-code** — standalone skills, hooks, and rules are file-watched, so an injected component loads on the worker's **next turn** with no reload command.
- **codex / gemini / pi** (and plugin/MCP kinds on any harness) — the component lands on disk and loads on **restart**.

Injected components are recorded in `.suit/lock.json` under a distinct `injected` list, so `suit current` shows them and `suit off` removes them. `suit off --keep-injected` tears down the `up`-applied dressing but leaves injected components in place.

> Injecting into a *remote* worker by name (`--target <owner>/<session>`, over the agent mesh) is on the roadmap. Today `suit inject` targets a local harness home via `--home`.

## Local content repo (point suit at a checkout)

If you're maintaining a content repo locally and want suit to read from it without cloning into `~/.local/share/suit/content/`:

```bash
export SUIT_CONTENT_PATH=~/projects/your-config
suit list outfits
suit claude --outfit backend
```

`SUIT_CONTENT_PATH` overrides the default cloned-content location for the current shell.

## How it works

`suit` reads YAML-frontmatter outfit and cut definitions, computes a per-session resolution (which skills to keep, which to drop, what cut prompt to inject), then prelaunches the target harness with a filtered view of `~/.<harness>/` mirrored to a tempdir. Your real `~/.<harness>/` is never modified.

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
