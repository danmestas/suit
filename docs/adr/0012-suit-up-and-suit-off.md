# ADR-0012: `suit up` / `suit off` — project-state mutator alongside the stateless launcher

Date: 2026-05-04
Status: Accepted

## Context

`suit <harness>` (the v0.3+ behavior) is a **stateless launcher**. Each invocation creates a tempdir under `/tmp/ac-prelaunch-<rand>/`, mirrors pieces of the user's harness home into it, applies the requested outfit/mode/accessories, spawns the harness binary against the tempdir, and `fs.rm`'s the tempdir on exit (`session.ts:249`). The user's project tree is never touched. The harness's real home is read but never written.

This works, but it has a sharp footgun: **native invocations of `claude` / `codex` / `pi` from inside the project see nothing suit-applied.** If the user launches Claude Code from their IDE, or runs `codex` directly, they get the unfiltered default config — not the outfit they "applied." The stateless launcher's contract — "ephemeral, only when you go through me" — does not match the daily-driver mental model of "I'm working on this project all afternoon, and I want the suit on for everything in this directory."

A discussion thread ([issue #17](https://github.com/danmestas/suit/issues/17)) explored an alternative: a **project-state mutator** that writes the resolved components directly into the project's `.claude/`, `.codex/`, `.pi/` etc., backed by a lockfile so removal is precise. Native harness invocations then inherit the suit automatically, IDE plugins benefit, the dressed config is sharable via `git`, and `suit off` cleanly reverses the operation.

The discussion converged on **keeping both modes**: the stateless launcher is the right answer for one-off "try this outfit for this query" workflows; the project-state mutator is the right answer for "wear this for the next few hours of work in this project."

## Decision

Add three new top-level commands alongside the existing `suit <harness>` flow:

| Command | Action |
|---|---|
| `suit up [--outfit X] [--mode Y] [--accessory A]...` | Resolve outfit + mode + accessories, emit per-harness components into the project's `.claude/`, `.codex/`, `.pi/` etc., persist `.suit/lock.json`. Interactive picker on TTY when args are missing. |
| `suit off` | Read `.suit/lock.json`, remove every tracked file (verifying sha256), remove empty dirs left behind, remove the lockfile. Idempotent. |
| `suit current` | Inspect `.suit/lock.json` and report what's currently applied (resolution metadata + emitted file count + any drift detected). |

The existing `suit <harness>` behavior is **unchanged and remains the default for one-off invocations.** A new `--ephemeral` flag is reserved (not implemented in v0.5) for explicitly forcing the per-session model even when a project is dressed; for now, when a project is dressed, `suit <harness>` works exactly as today (the dressed `.claude/` etc. and the per-session prelaunch tempdir don't conflict because the harness picks up whatever its CLI surface points at).

### Resolution semantics

`suit up` runs the same resolver as `suit <harness>`:

1. Empty component set
2. Apply outfit → seeds baseline
3. Apply mode (with optional `include:` overlay per ADR-0010 Phase 3)
4. Apply each `--accessory` in CLI order
5. Run the harness adapters' emit logic against a `Writer` abstraction

The `Writer` is the new piece: today's tempdir flow uses `TempdirWriter`; `suit up` uses `ProjectWriter`. Same emit code, different output sink. This requires a Phase A refactor of the adapter `emit()` calls so output paths are sink-agnostic.

### Lockfile shape

`.suit/lock.json` at the project root:

```json
{
  "schemaVersion": 1,
  "appliedAt": "2026-05-04T19:06:54Z",
  "resolution": {
    "outfit": "backend",
    "mode": "focused",
    "accessories": ["axiom", "linear"]
  },
  "files": [
    {
      "path": ".claude/CLAUDE.md",
      "sha256": "<hex>",
      "sourceComponent": "outfits/backend"
    },
    {
      "path": ".claude/skills/idiomatic-go/SKILL.md",
      "sha256": "<hex>",
      "sourceComponent": "skills/idiomatic-go"
    }
  ]
}
```

The `sourceComponent` field is informational — useful for `suit current` output. Removal is driven entirely by `path` + `sha256`.

### Merge strategy: strict (refuse-when-dirty)

`suit up`:
- If a target file exists and is **NOT** in a prior `.suit/lock.json` → fail with `target exists and is not suit-managed: <path>`. User can `--force` to overwrite, or hand-merge then re-run.
- If a target file exists and **IS** in a prior lockfile, but its current sha256 doesn't match the recorded sha256 (user hand-edited) → fail with `target hand-edited since suit applied it: <path>`. User can `--force` to overwrite, or save changes elsewhere.
- If `.suit/lock.json` exists and the user's flags resolve to a different combination than the recorded one → fail with `project already dressed: <prior resolution>. Run \`suit off\` first, or pass --force to switch.`

`suit off`:
- For each path in `.suit/lock.json#files`: if its sha256 matches the recorded value, delete it; otherwise refuse (file was hand-edited; `--force` overrides).
- After deletion, remove now-empty dirs (e.g. `.claude/skills/idiomatic-go/`).
- Delete `.suit/lock.json`.
- A missing or absent lockfile is a no-op (idempotent).

This strictness is deliberate: the cost of one extra `git stash` or `--force` flag is dwarfed by the cost of silently overwriting hand-authored project config. Users who want the "loose" merge can use `--force` explicitly.

### Interactive picker (TTY only)

When `suit up` is invoked on a TTY and outfit is missing (mode and accessories are optional), prompt:

```text
$ suit up

Outfit:       (pick one)
  1. backend       Backend dev work — Go, observability, infra
  2. frontend      Frontend / Datastar work
  3. personal      Personal projects, journaling
  4. machines      Machine + server management
  5. aviation      Aviation / flight planning
  6. taxes         Tax preparation
> 1

Mode:         (pick one, or empty to skip)
  1. code        Software development
  2. design      UI / UX / interaction
  3. focused     Single-task deep focus
  4. ops         Operations / on-call
> 3

Accessories:  (pick multiple by number, comma-separated; empty to skip)
  (none yet defined in this wardrobe)
>

→ Resolved: outfit=backend, mode=focused, accessories=[]
→ Applying to /Users/foo/projects/bar/...
   .claude/CLAUDE.md
   .claude/skills/idiomatic-go/SKILL.md
   …
   .suit/lock.json
✓ Done. Run `suit current` to inspect, `suit off` to remove.
```

Implementation: simple numbered list + Node's `readline` against stdin. **No new dependency.** Each section reuses the existing `listAllOutfits` / `listAllModes` / `listAllAccessories` from the discovery layer.

Non-TTY runs (CI, scripts, piped stdin) skip the picker entirely; missing outfit raises `--outfit required when stdin is not a TTY`.

### Multi-harness coupling

`suit up` dresses **all** harnesses targeted by the resolved components — same fan-out as today's prelaunch chain. A `--target <harness>` flag is reserved for future scoping (e.g., "only write Claude Code's config, leave .codex/ alone") but not part of v0.5. Day-one users want one command to dress the whole project.

### `.gitignore` posture

By default, suit does **not** modify `.gitignore`. Whether to commit the dressed `.claude/`, `.codex/`, etc. is a per-project choice:

- **Commit** when teammates should inherit the dressed suit (e.g., a shared project where everyone uses the same outfit).
- **`.gitignore`** when the suit is personal (your own dotfile-shaped overlay on a shared project).

Both stances are valid; `suit up` makes neither for you. The ADR documents this as a recommendation, not a default.

### Interaction with content-repo updates

If the wardrobe is updated (`suit sync`) after a `suit up`, the dressed project is now stale relative to the source. v0.5 does **not** auto-refresh — that smells like a magic action. Users explicitly run `suit up --refresh` (a future flag, not in v0.5) or `suit off && suit up --outfit X --mode Y --accessory ...` to re-dress. v0.5 ships without `--refresh`; if drift is detected (sha256 of source component differs from tracked sourceComponent at apply-time), `suit current` reports it as informational.

## Consequences

**Positive:**
- Native harness CLI works inside dressed projects. IDE plugins, auto-launchers, and shell aliases all inherit the suit transparently.
- The dressed config shows in `git status` — visible, reviewable, sharable.
- Sharable via git — commit `.claude/` etc. and a teammate cloning the project sees the same outfit applied.
- The two-mode model is honest: stateless for queries, stateful for sessions. No magic switching.

**Negative:**
- Mutates the project tree. Risks clobbering hand-authored project config — strict mode mitigates but doesn't eliminate. `--force` is the escape hatch.
- Switching outfits mid-session is more expensive than the stateless launcher: `suit off && suit up --outfit Y` is two filesystem trips vs. zero. Mitigated by the fact that `suit <harness>` is still available for one-off "try this outfit" cases.
- Diff noise: every outfit change shows up as a large diff. Authors might commit those by accident; documented as a trade-off, not a bug.
- Lockfile sha256 verification is per-file; on a project with hundreds of skills, `suit off` becomes I/O-bound. Unlikely to matter in practice (sha256 of small markdown files is fast).

**Neutral:**
- The `Writer` abstraction added in Phase A is a small refactor that improves testability for adapter emit logic (can write to an in-memory sink in tests without touching disk).
- `--ephemeral` flag reserved for future use — not part of v0.5 surface.

## Alternatives considered

**Replace the stateless launcher entirely.** Rejected. Per-session "try this for one query" is a real workflow; killing it in favor of "always state-mutate" forces users into an `up && do thing && off` cycle for every experimental invocation. Worst of both worlds.

**Three-way merge instead of refuse-when-dirty.** Rejected for v0.5. Three-way merge requires tracking pristine source content alongside applied content alongside the user's edits. The complexity-to-value ratio is bad for a tool whose primary job is composition, not version control. `--force` is the escape hatch; users who want a smarter merge can run `suit off`, do their work, and re-apply.

**Section markers (`<!-- suit:begin --> ... <!-- suit:end -->`) for in-place merging.** Rejected. Coarse — only works for single-file targets like `CLAUDE.md`, doesn't help with the bulk of emitted artifacts (per-skill `SKILL.md` files in `.claude/skills/<X>/`, hook scripts, etc.). Also adds visual clutter in the user's CLAUDE.md that they didn't author.

**Auto-detect "dressed" state and switch `suit <harness>` semantics.** Rejected. If a project has `.suit/lock.json`, should `suit claude` skip the prelaunch tempdir and let claude run natively against the dressed `.claude/`? Probably yes — but introducing implicit behavior change based on project state is the kind of magic that surprises users. The explicit `--ephemeral` flag (reserved, not in v0.5) is the planned answer if/when this becomes a real pain point.

**Add a dependency for the interactive picker** (`@inquirer/prompts`, `enquirer`, etc.). Rejected. The picker UI is a numbered list and a single `readline.question()` call per primitive — readline is in Node's standard library. Adding a dep for ten lines of code is dependency creep.

## Related

- [ADR-0010](./0010-rename-and-three-tier-composition.md) — outfit/mode/accessory composition model. `suit up` consumes the same resolver.
- [ADR-0011](./0011-wardrobe-layout-v2.md) — wardrobe layout. `suit up` reads from the same content discovery tiers.
- [Issue #17](https://github.com/danmestas/suit/issues/17) — the discussion that produced this decision.
