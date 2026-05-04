# Usage guide

A task-oriented walkthrough of `suit`. The [README](../README.md) has install + quick-start; this guide is for when you actually want to drive the tool.

## 1. Overview

`suit` is a CLI that filters and composes harness configs (Claude Code, Codex, Gemini CLI, GitHub Copilot, APM, Pi) using YAML-frontmatter outfit files, mode files, and skills. The CLI ships separately from the content it reads: you install `@agent-ops/suit` once, point it at a content repo (clone the canonical [`suit-template`](https://github.com/danmestas/suit-template) or fork your own), then launch any harness through `suit <harness>` to apply the outfit and mode you want for that session.

The mental model is:

| Layer | Where it lives | Mutability |
|---|---|---|
| Tool | `@agent-ops/suit` from npm | Stable; bumped on release |
| Content | Cloned content repo at `~/.local/share/suit/content/` | You edit / pull |
| Overlays | `~/.config/suit/` (user) and `<cwd>/.suit/` (project) | Optional; override content |
| Harness HOME | `~/.<harness>/` (e.g., `~/.claude/`) | Never touched by `suit` |

`suit` mirrors the relevant pieces of `~/.<harness>/` into a per-session tempdir, drops in the kept skills, generates an injected prompt or `AGENTS.md`, and spawns the harness binary against that tempdir. Your real harness home stays untouched.

For the deeper "why" behind individual decisions, see [docs/adr/](./adr/).

## 2. Installation and first run

```bash
npm install -g @agent-ops/suit
suit --help          # verify the binary is on PATH
suit init            # clones the default suit-template
suit status          # confirm content + harness presence
```

`npm install -g @agent-ops/suit` puts two binaries on PATH:

| Binary | Role |
|---|---|
| `suit` | The runtime launcher you invoke directly |
| `suit-build` | A build helper that `suit` shells out to for Codex/Copilot prelaunch (rarely invoked by hand) |

Both must be on PATH together; if one is missing you'll see `ENOENT: spawn suit-build` when launching Codex or Copilot. A `suit init` with no URL reads `suit.templateUrl` from the package's `package.json` (default: `https://github.com/danmestas/suit-template`) and clones it into `~/.local/share/suit/content/`. Pass a positional URL to use a different template:

```bash
suit init https://github.com/your-org/your-config
```

If the target directory already exists, `suit init` refuses without `--force`. Re-clone with:

```bash
suit init --force https://github.com/your-org/your-config
```

After init, run `suit status` to confirm:

```text
suit     v0.3.0
Content: /Users/you/.local/share/suit/content (clone of https://github.com/danmestas/suit-template.git)
Harness: claude-code OK  apm OK  codex OK  gemini OK  copilot OK  pi OK
```

If a harness shows missing, install that harness's CLI separately. `suit` doesn't bundle them.

## 3. Day-to-day commands

The full surface (from `suit --help`):

```text
suit <harness> [--outfit X] [--mode Y] [--accessory A]... [--no-filter] [-- <harness args>]
suit init [<url>] [--force]    (defaults to suit.templateUrl from package.json)
suit sync
suit status
suit doctor
suit list <outfits|modes|accessories>
suit show <outfit|mode|accessory> <name>
```

### 3.1 `suit <harness>` — the launcher

The most-used command. Spawns a harness binary against a tempdir that has outfits, modes, and filtered skills applied.

| Element | Meaning |
|---|---|
| `<harness>` | One of `claude-code`, `codex`, `gemini`, `copilot`, `apm`, `pi`. (`claude` is an accepted shorthand for `claude-code`.) |
| `--outfit <name>` | Apply the named outfit. Skills are filtered by its `categories`, `skill_include`, `skill_exclude`. |
| `--mode <name>` | Apply the named mode. The mode's body is injected as additional context. |
| `--accessory <name>` | Apply the named accessory as a piecemeal overlay on top of the outfit + mode. **Repeatable** — pass `--accessory` multiple times to layer in multiple. Layered left-to-right in CLI order. |
| `--no-filter` | Skip outfit, mode, **and accessory** loading — launch the harness as-is for one session. Useful when you suspect filtering is hiding something. |
| `--verbose` | Extra logging from `suit`'s prelaunch step. |
| `-- <args>` | Everything after `--` is passed verbatim to the harness binary. |

`--accessory` is **repeatable**: every occurrence pushes a name onto an
ordered list, and accessories are applied left-to-right after outfit + mode.
A reference to a missing component inside an accessory's `include:` block is
a hard error — the resolver fails fast with `accessory "X" includes <kind>
"Y" not found in wardrobe` rather than silently emitting a partial session.

Examples:

```bash
suit claude --outfit backend --mode focused
suit claude --outfit backend --accessory tracing --accessory pr-policy
suit codex --outfit frontend -- --resume sess-123
suit gemini --outfit personal --mode focused
suit claude --no-filter      # launch with no outfit/mode/accessory applied
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Harness exited cleanly |
| 1 | Runtime error in `suit` itself |
| 2 | Usage error (bad flag, unknown harness, missing arg) |
| (other) | Whatever the harness binary returned |

### 3.2 `suit list <outfits|modes|accessories>`

Lists every outfit, mode, or accessory discovered across the 3 tiers. The output is `name version [tier] description`:

```bash
$ suit list outfits
backend       v1.0.0    [builtin]  Backend dev work — Go, observability, infra, philosophy
frontend      v1.0.0    [builtin]  Frontend / Datastar work
machines      v1.0.0    [builtin]  Machine + server management
personal      v1.0.0    [builtin]  Personal projects, journaling

$ suit list accessories
pr-policy     v1.0.0    [builtin]  Force PR-policy rules into this session
tracing       v1.0.0    [builtin]  Add OpenTelemetry tracing context
```

The `[tier]` column is `project` / `user` / `builtin` — useful for confirming an overlay actually wins. When no accessories exist anywhere, the command prints `(no accessories found)`.

### 3.3 `suit show <outfit|mode|accessory> <name>`

Pretty-prints the resolved manifest plus body. Resolution honors the 3-tier chain (project beats user beats builtin):

```bash
$ suit show outfit backend
name: backend
version: 1.0.0
source: builtin (/Users/you/.local/share/suit/content/outfits/backend/outfit.md)
description: Backend dev work — Go, observability, infra, philosophy
targets: claude-code, apm, codex, gemini, copilot, pi
categories: tooling, workflow, contextmanagement, evolution, backpressure
skill_include: idiomatic-go
skill_exclude: datastar-tao, datastar-patterns, datastar
```

For modes, `suit show mode <name>` also prints the prompt body that gets injected.

For accessories, `suit show accessory <name>` prints the same header plus the `include:` block:

```bash
$ suit show accessory tracing
name: tracing
version: 1.0.0
source: builtin (/Users/you/.local/share/suit/content/accessories/tracing/accessory.md)
description: Add OpenTelemetry tracing context to a session
targets: claude-code, codex, pi
include:
  skills: otel-conventions
  rules:
  hooks: trace
  agents:
  commands:
```

If the accessory has body content, it's printed beneath a `--- body ---` section the same way outfits do.

### 3.4 `suit status` (and bare `suit`)

A one-shot summary. Bare `suit` (no args) is an alias for `suit status`:

```text
suit     v0.3.0
Content: /Users/you/.local/share/suit/content (clone of https://github.com/danmestas/suit-template.git)
Harness: claude-code OK  apm OK  codex OK  gemini OK  copilot MISSING  pi OK
```

If the content directory doesn't exist, the second line says `(none — run \`suit init <url>\`)`. If it exists but isn't a git repo, you'll see `(not a git repo)`. If git config is corrupted, you'll see `(error: ...)` rather than a thrown exception.

### 3.5 `suit doctor`

Verifies each known harness binary is on PATH. Prints checkmarks (or X marks) and exits 0 if all are found, 1 otherwise:

```text
$ suit doctor
OK  claude-code (/Users/you/.local/share/mise/installs/node/lts/bin/claude)
OK  apm (/usr/local/bin/apm)
OK  codex (/Users/you/.local/share/mise/installs/node/lts/bin/codex)
OK  gemini (/Users/you/.local/share/mise/installs/node/lts/bin/gemini)
MISSING copilot
OK  pi (/Users/you/.local/share/mise/installs/node/lts/bin/pi)
```

`MISSING` here is informational. `suit` works fine for the harnesses you have.

### 3.6 `suit sync`

Pulls the content repo. Refuses if there are uncommitted changes or if the directory isn't a git repo:

```bash
$ suit sync
Already up to date
```

| Pre-condition | Behavior |
|---|---|
| Content dir doesn't exist | Errors: "run `suit init <url>` first" — exit 1 |
| Dir exists but isn't a git repo | Errors: "not a git repo. Re-run `suit init`" — exit 1 |
| Working tree dirty | Errors: "uncommitted changes. Stash or commit them, then re-run" — exit 1 |
| Already up to date | Prints "Already up to date" — exit 0 |
| New commits | Pulls and reports count — exit 0 |

### 3.7 `suit init [<url>] [--force]`

Clones a content repo. Without `<url>`, reads `suit.templateUrl` from the installed package's `package.json`. Forks of `suit` itself can change that field to point at their own template.

```bash
suit init                                                 # default suit-template
suit init https://github.com/your-org/your-config         # explicit URL
suit init --force https://github.com/your-org/your-config # blow away existing
```

Exit codes: 0 on success, 1 on git failure, 2 on missing URL with no `templateUrl` configured.

After clone, `suit init` warns (but does not fail) if the cloned repo has neither `outfits/` nor `modes/` — that probably means you pointed at the wrong repo.

## 4. Outfits, modes, and skills

These are the three composable units `suit` operates on. All three are markdown files with YAML frontmatter.

### 4.1 Outfit

A outfit declares who the agent is for this session. Frontmatter shape:

```yaml
---
name: backend
version: 1.0.0
type: outfit
description: Backend dev work — Go, observability, infra, philosophy
targets: [claude-code, apm, codex, gemini, copilot, pi]
categories: [tooling, workflow, contextmanagement, evolution, backpressure]
skill_include: [idiomatic-go]
skill_exclude: [datastar-tao, datastar-patterns, datastar]
---

System prompt body that frames the outfit's role.
```

| Field | Meaning |
|---|---|
| `name` | Slug used on the CLI (`--outfit backend`) |
| `version` | Semver; bump it when the outfit changes meaningfully |
| `type` | Always `outfit` |
| `description` | One-liner shown in `suit list outfits` |
| `targets` | Which harnesses this outfit is valid for. If you launch a harness not in `targets`, `suit` errors. |
| `categories` | Taxonomy tags. Skills are kept if their `primary` (or `secondary`) overlaps. |
| `skill_include` | Force-include these skills regardless of category match |
| `skill_exclude` | Force-exclude these skills regardless of category match |

The body (after the frontmatter `---`) becomes additional context injected at session start.

### 4.2 Mode

A mode is a smaller, swappable prompt overlay — typically a working stance like "focused" or "design":

```yaml
---
name: focused
version: 1.0.0
type: mode
description: Single-task deep focus, no scope creep
targets: [claude-code, apm, gemini, codex, copilot, pi]
categories: [tooling]
skill_include: []
skill_exclude: []
---

Body: a few hundred words framing the mode. Capped at 4096 bytes.
```

Modes compose with outfits: `--outfit backend --mode focused` applies both.

### 4.3 Accessory

An **accessory** is a piecemeal overlay layered after outfit + mode at invocation time. Where an outfit defines a complete role and a mode flavors the workflow, an accessory adds (typically) a single extra component or a small named bundle. Pass `--accessory <name>` once per accessory you want layered in, in any order — accessories compose left-to-right after the outfit's category-based filtering.

Frontmatter shape:

```yaml
---
name: tracing
version: 1.0.0
type: accessory
description: Add OpenTelemetry tracing context to a session
targets: [claude-code, codex, pi]
include:
  skills: [otel-conventions]
  rules: []
  hooks: [trace]
  agents: []
  commands: []
---
```

| Field | Meaning |
|---|---|
| `name` | Slug used on the CLI (`--accessory tracing`) |
| `version` | Semver |
| `type` | Always `accessory` |
| `description` | One-liner shown in `suit list accessories` |
| `targets` | Which harnesses this accessory is valid for |
| `include.skills` | Skill names to force-include — overrides the outfit's category drop. |
| `include.rules` | Rules names to layer in (validated against the catalog). |
| `include.hooks` | Hook names to layer in. |
| `include.agents` | Agent names to layer in. |
| `include.commands` | Command names (no first-class type yet; treated as informational). |

All five sub-arrays default to `[]` so you only declare the keys you care about.

**Strict-include semantics.** Each name in `include.skills`, `include.rules`, `include.hooks`, and `include.agents` is validated against the discovered component catalog at resolve time. A missing reference fails resolution with a precise error like:

```
accessory "tracing" includes hook "trace" not found in wardrobe
```

This catches typos at prelaunch instead of letting the session start with a silently-dropped component. Accessories cannot reference unknown components.

**Composition order.** The resolver applies outfit → mode → each accessory in CLI order. Accessory force-includes override the outfit's category-based drops: a skill the outfit would normally filter out is brought back in if any active accessory names it.

### 4.4 Skill

Skills are the stuff the outfit's category list filters. Each skill lives under `skills/<name>/SKILL.md` (or `skill.md` for Gemini) with frontmatter:

```yaml
---
name: idiomatic-go
version: 1.0.0
type: skill
description: Go-idiomatic refactor pass
primary: backpressure
secondary: [tooling]
---

Skill body — the actual prompt that ships with the skill.
```

Skill resolution per session:

1. Start with all skills found in the harness's normal skills dir (e.g., `~/.claude/skills/`) plus skills defined in the content repo.
2. Keep skills whose `primary` or `secondary` category overlaps with the outfit's `categories`.
3. Force-add anything in `skill_include`.
4. Force-drop anything in `skill_exclude`.
5. Mirror the kept set into the session tempdir.

### 4.5 What `suit claude --outfit X --mode Y` actually does

Step by step:

1. Resolve `X` and `Y` against the 3-tier chain (project → user → builtin).
2. Load the harness's catalog of skills from `~/.<harness>/skills/`.
3. Filter by the outfit's categories, then apply `skill_include` / `skill_exclude`.
4. Build a tempdir mirror of `~/.<harness>/` containing only the kept skills, plus an injected prompt assembled from outfit body + mode body.
5. For Codex and Copilot, also generate `AGENTS.md` (or `copilot-instructions.md`) from the same resolution into the tempdir, since those harnesses read project-root files instead of skills.
6. Spawn the harness binary with `HOME` (or `cwd`) overridden to the tempdir.

Your real `~/.<harness>/` is never modified. See ADR-0002 for the two-binary split that makes step 5 work.

## 5. Content sources and resolution order

Outfits, modes, accessories, and skills are looked up across three tiers, highest priority first:

| Priority | Tier | Path |
|---|---|---|
| 1 | Project overlay | `<cwd>/.suit/outfits/<name>.md` (and `modes/`, `accessories/`, `skills/`) |
| 2 | User overlay | `~/.config/suit/outfits/<name>.md` (and `modes/`, `accessories/`, `skills/`) |
| 3 | Default content | `~/.local/share/suit/content/outfits/<name>/outfit.md` (or `<name>.md` for non-builtin tiers; `accessories/<name>/accessory.md` likewise) |

Note the slight shape difference: builtin uses a `<name>/outfit.md` directory layout, while the overlay tiers accept a flat `<name>.md`. Both work — `suit list` shows whichever tier found it.

Worked example. Say you have a `backend` outfit in your cloned content (builtin tier) and want to tweak it for one repo:

```bash
mkdir -p /path/to/my-repo/.suit/outfits
cat > /path/to/my-repo/.suit/outfits/backend.md <<'EOF'
---
name: backend
version: 1.0.1
type: outfit
description: Backend outfit, repo-specific overrides
targets: [claude-code]
categories: [tooling, workflow]
skill_include: []
skill_exclude: [idiomatic-go]
---

Body text overrides the builtin one when run from this repo.
EOF

cd /path/to/my-repo
suit show outfit backend     # source: project (...)
```

To make an override that follows you across all repos, drop the same file at `~/.config/suit/outfits/backend.md`. Project overlays still beat it.

### 5.1 Environment variables

| Variable | Effect |
|---|---|
| `SUIT_CONTENT_PATH` | Replace tier 3 entirely. Useful for dev-mode against a working content repo. |
| `XDG_DATA_HOME` | Move tier 3 to `$XDG_DATA_HOME/suit/content/` instead of `~/.local/share/suit/content/`. |
| `XDG_CONFIG_HOME` | Move tier 2 to `$XDG_CONFIG_HOME/suit/` instead of `~/.config/suit/`. |

`SUIT_CONTENT_PATH` wins over `XDG_DATA_HOME` for the content directory specifically. Common dev pattern:

```bash
export SUIT_CONTENT_PATH=~/projects/agent-config
suit list outfits       # reads from your working content repo
suit claude --outfit backend
```

See ADR-0003 (env-var-based content discovery) and ADR-0007 (path migration policy; superseded — legacy `~/.config/agent-config/` and `.agent-config/` paths are no longer read in v0.3.0).

## 6. Authoring content

Choose a tier first:

| Goal | Tier | Path |
|---|---|---|
| Sharable outfit/mode/skill maintained in version control | Default content | `~/.local/share/suit/content/outfits/<name>/outfit.md` (or in the source repo and pulled via `suit sync`) |
| Personal override across all repos | User | `~/.config/suit/outfits/<name>.md` |
| Repo-specific override | Project | `<repo>/.suit/outfits/<name>.md` |

Most authoring happens in the default-content tier — that's the cloned repo. Edit it, commit, push to your fork; everywhere else `suit sync` picks it up.

The canonical `suit-template` (and forks of it) ships slash commands under `.claude/commands/` to scaffold new content with AI assistance:

| Command | What it does |
|---|---|
| `/new-outfit` | Interactively author a new outfit file |
| `/new-mode` | Interactively author a new mode file |
| `/new-skill` | Interactively author a new skill file |
| `/new-plugin` | Author a multi-file plugin bundle |

Run them inside Claude Code from a checkout of your content repo. They handle the frontmatter, validate against `TAXONOMY.md`, and place the file in the right directory.

If you'd rather author by hand, copy a sibling and edit. A minimal outfit:

```yaml
---
name: my-outfit
version: 1.0.0
type: outfit
description: One-line description
targets: [claude-code, codex]
categories: [tooling, workflow]
---

System prompt body that frames the outfit's role. Markdown is fine here.
```

The `categories` list must match entries in your content repo's `TAXONOMY.md`. The default `suit-template` ships an 8-category taxonomy (Economy, Workflow, BackPressure, Tooling, ContextManagement, Evolution, plus two more); use those names verbatim. Validation errors will name `TAXONOMY.md` if the category isn't recognized.

## 7. Configuration

### 7.1 `suit.config.yaml` (content-repo root)

A single file at the root of your content repo declares per-harness defaults. Per-skill overrides live in the skill's own frontmatter; `suit.config.yaml` is the fallback.

Example (from `agent-config`):

```yaml
# Repo-level adapter defaults. Per-component overrides live in SKILL.md frontmatter.
apm:
  package_scope: "@danmestas"
claude-code:
  marketplace: claude-plugins-official
codex:
  agents_md_section_order: [rules, agents, skills]
gemini:
  user_settings_path: "~/.gemini/settings.json"
copilot:
  hooks_dir: ".github/hooks"
pi:
  package_keyword: "pi-package"
```

The keys map 1:1 to harness names. What each one means depends on the harness adapter. If you fork `suit-template`, copy the file as-is and edit the values you care about; missing keys fall back to adapter defaults.

### 7.2 `package.json` `suit.templateUrl`

When you run `suit init` with no URL, `suit` reads `suit.templateUrl` from its own `package.json`:

```json
{
  "suit": {
    "templateUrl": "https://github.com/danmestas/suit-template"
  }
}
```

Forks of `suit` itself (not content forks — tool forks) point this at their own template so their users get a sensible default. Content forks do not need to change anything; users pass the URL explicitly to `suit init <url>`.

### 7.3 Environment variables (recap)

| Variable | Default | Effect |
|---|---|---|
| `SUIT_CONTENT_PATH` | (unset) | Override content directory. Wins over XDG. |
| `XDG_DATA_HOME` | `~/.local/share` | Reroots the cloned content directory. |
| `XDG_CONFIG_HOME` | `~/.config` | Reroots the user overlay directory. |
| `HOME` | OS-default | Fallback for all of the above. Tests inject this. |

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `outfit "X" not found` | Typo, or outfit lives in a tier `suit` isn't reading | `suit list outfits` shows what's discoverable; check `[tier]` column |
| `mode "Y" not found` | Same | `suit list modes` |
| `suit init` says "already exists" | Content dir already populated | `suit sync` to update, or `suit init --force <url>` to overwrite |
| `suit sync` errors with "uncommitted changes" | Working tree dirty in content dir | `cd ~/.local/share/suit/content && git status`, then stash or commit |
| `suit sync` errors with "not a git repo" | Content dir isn't from `suit init`, or `.git/` was deleted | `suit init --force <url>` to re-clone |
| `ENOENT: spawn suit-build` on `suit codex` or `suit copilot` | `suit-build` isn't on PATH | Reinstall: `npm install -g @agent-ops/suit` (puts both binaries on PATH) |
| Claude Code can't see a skill you expect | Outfit's `categories` don't overlap with skill's `primary`/`secondary` | `suit show outfit <name>`, then check the skill's frontmatter — add the right category, or use `skill_include` |
| Validation errors mention `TAXONOMY.md` | Your content repo lacks `TAXONOMY.md`, or you used a category name not in it | Copy `TAXONOMY.md` from `suit-template` into your content repo root |
| `suit doctor` says a harness is missing | Harness binary isn't installed | Install the harness's CLI (`npm install -g @anthropic-ai/claude-code` etc.); `suit` doesn't bundle them |
| `suit status` says `Content: (none)` | First-run state | Run `suit init` |
| `suit status` says `Content: ... (error: ...)` | Corrupted git config in the content dir | Inspect `~/.local/share/suit/content/.git/config`; usually `suit init --force <url>` clears it |
| `--outfit X` errors with "harness not in targets" | Outfit's `targets` doesn't include the harness you're launching | Edit the outfit's `targets` list, or pick a different outfit |
| Filtering hides everything you want | Outfit's `categories` is too narrow | Run with `--no-filter` for one session to confirm; widen categories or use `skill_include` |

If `suit status` looks healthy but a launch silently fails, re-run with `--verbose` to see the prelaunch step.

## 9. Cheat sheet

| Command | Purpose | Most-common form |
|---|---|---|
| `suit --help` | Show usage | `suit --help` |
| `suit init [<url>]` | Clone content repo | `suit init` (uses `templateUrl`) |
| `suit init --force <url>` | Re-clone, overwriting | `suit init --force https://github.com/.../...` |
| `suit sync` | `git pull` content repo | `suit sync` |
| `suit status` | Show version, content, harness presence | `suit status` (or bare `suit`) |
| `suit doctor` | Verify each harness binary on PATH | `suit doctor` |
| `suit list outfits` | List discoverable outfits | `suit list outfits` |
| `suit list modes` | List discoverable modes | `suit list modes` |
| `suit list accessories` | List discoverable accessories | `suit list accessories` |
| `suit show outfit <name>` | Print resolved outfit | `suit show outfit backend` |
| `suit show mode <name>` | Print resolved mode + body | `suit show mode focused` |
| `suit show accessory <name>` | Print resolved accessory + include block | `suit show accessory tracing` |
| `suit <harness>` | Launch with outfit/mode/accessory | `suit claude --outfit backend --mode focused --accessory tracing` |
| `suit <harness> --no-filter` | Launch without filtering | `suit claude --no-filter` |
| `suit <harness> -- <args>` | Pass-through to harness | `suit codex --outfit frontend -- --resume sess-123` |

| Env var | Effect |
|---|---|
| `SUIT_CONTENT_PATH` | Override content dir |
| `XDG_DATA_HOME` | Reroot cloned content |
| `XDG_CONFIG_HOME` | Reroot user overlay |

| Tier | Path | Beats |
|---|---|---|
| Project | `<cwd>/.suit/` | User, builtin |
| User | `~/.config/suit/` | Builtin |
| Builtin | `~/.local/share/suit/content/` | — |

See also: [ADR index](./adr/README.md) for design decisions, especially ADR-0001 (three-repo split), ADR-0002 (`suit` vs `suit-build`), ADR-0003 (`SUIT_CONTENT_PATH`), and ADR-0008 (ContentStore as a deep module).
