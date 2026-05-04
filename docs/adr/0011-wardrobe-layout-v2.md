# ADR-0011: Wardrobe layout v2 — flatten primitives, drop plugin/marketplace bundling

Date: 2026-05-04
Status: Accepted

## Context

The content repo (today `agent-config`, renamed to `wardrobe` alongside this ADR) has accreted a confused directory structure over its lifetime. As of v0.3 it contains:

- `personas/` — 6 entries (top-level by-type)
- `modes/` — 4 entries (top-level by-type)
- `agents/` — 5 entries with `SKILL.md` files (top-level by-type)
- `hooks/` — 3 entries with `SKILL.md` files (top-level by-type), some with nested `extensions/` subdirs
- `plugins/` — 7 sub-bundles (`bones-powers`, `flight-deck`, `career-interview`, `gh-project-management`, `knowledge-base`, `monorepo-profiles`, `stasi`), each with their own `skills/`, `hooks/`, `commands/`, `.claude-plugin/` subdirs
- `marketplace/` — APM-related metadata (`plugins/`, `skills/` subdirs)
- `dist/` — build cache from `suit-build` checked into git
- `.agents/skills/skill-creator/SKILL.md` — orphan legacy path
- `LICENSES/` — multi-file license dir
- Top-level: `AGENTS.md` (auto-generated), `CHANGELOG.md`, `CONTEXT.md`, `CONTRIBUTING.md`, `CONVENTIONS.md`, `GH_PROJECT_SETUP_GUIDE.md`, `README.md`, `suit.config.yaml`, `SUPERPOWERS_ARCHITECTURE.md`, `TAXONOMY.md`

Counted SKILL.md files by parent directory: 71 under `plugins/*/skills/`, 5 under `agents/`, 3 under `hooks/`, 1 stray under `plugins/`. Eighty SKILL.md files, scattered across four parent-dir patterns, with no single source of truth.

Concretely problematic:

1. **Mixed organization.** Some primitives live by-type at the top level (`personas/`, `modes/`, `hooks/`); others live by-bundle inside `plugins/`. Finding a skill requires checking 4 places.
2. **Plugin concept is dead-weight.** ADR-0010 introduces `accessory` as the primitive for small, named bundles, and `outfit` for large bundles. The `plugins/` directory exists only because at some point the project distributed bundles via APM. With APM no longer required (see Decision below), `plugins/` is duplicative with the new outfit/accessory primitives.
3. **Build artifact in source.** `dist/` is a build cache emitted by `suit-build`. It is checked into git but rebuilt every time. Pure pollution.
4. **Marketplace dir** — `marketplace/plugins/`, `marketplace/skills/` — APM artifact.
5. **Component target metadata is inconsistent.** During the v0.3 docker-realtime smoke test, `suit codex --outfit backend` produced `(0 components)` for codex emit because most skills declare `targets: [claude-code]` only. The wardrobe is implicitly Claude-only despite the multi-harness premise.

## Decision

**Wardrobe v2 directory layout:**

```text
wardrobe/
├── README.md
├── CHANGELOG.md
├── suit.config.yaml                # adapter defaults (unchanged shape)
│
├── outfits/                        # was personas/
│   ├── backend/outfit.md
│   ├── frontend/outfit.md
│   ├── personal/outfit.md
│   ├── machines/outfit.md
│   ├── aviation/outfit.md
│   └── taxes/outfit.md
│
├── modes/                          # unchanged dir, expanded semantics (per ADR-0010)
│   ├── code/mode.md
│   ├── design/mode.md
│   ├── focused/mode.md
│   └── ops/mode.md
│
├── accessories/                    # NEW
│   ├── tracing/accessory.md
│   ├── pr-policy/accessory.md
│   └── ...
│
├── skills/                         # FLAT shared pool (was 80 scattered files)
│   ├── idiomatic-go/SKILL.md
│   ├── tdd/SKILL.md
│   ├── systematic-debugging/SKILL.md
│   └── ...
│
├── agents/                         # was 5 entries with SKILL.md
│   ├── code-reviewer/AGENT.md
│   ├── golang-pro/AGENT.md
│   └── ...
│
├── rules/                          # NEW top-level
│   ├── pr-policy/RULES.md
│   └── ...
│
├── hooks/                          # promoted to flat top-level
│   ├── trace/HOOK.md
│   ├── recall/HOOK.md
│   └── ...
│
├── commands/                       # NEW top-level
│   └── ...
│
└── docs/
    ├── CONTEXT.md
    ├── CONVENTIONS.md
    ├── TAXONOMY.md
    └── adr/
```

**Filename convention:**

- `outfit.md`, `mode.md`, `accessory.md` — lowercase. These are suit-vocabulary primitives; their filename matches their dir name.
- `SKILL.md`, `AGENT.md`, `RULES.md`, `HOOK.md`, `COMMAND.md` — uppercase. These are harness-component primitives. `SKILL.md` retains its uppercase ecosystem-standard form (Claude Skills, Anthropic plugin ecosystem). The other harness-component filenames mirror that capitalization for consistency.

**Outfit frontmatter shape:**

```yaml
---
name: backend
version: 1.0.0
description: Backend dev work — Go, observability, infra
targets: [claude-code, codex, pi]
include:
  skills: [idiomatic-go, tdd, systematic-debugging]
  rules: [pr-policy]
  hooks: [trace]
  agents: [code-reviewer, golang-pro]
  commands: []
---
# Backend Outfit
<body — context for any harness using this outfit>
```

**Accessory frontmatter shape:**

```yaml
---
name: tracing
version: 1.0.0
description: Add OpenTelemetry tracing context to a session
targets: [claude-code, codex, pi]
include:
  skills: [otel-conventions]
  hooks: [trace]
---
```

**Mode frontmatter shape (expanded per ADR-0010):**

```yaml
---
name: ticket-writing
version: 1.0.0
description: Writing GitHub issues / PRDs
include:                        # optional; modes can carry components now
  skills: [linear-method, to-issues]
  rules: [issue-style]
---
# Body — injected as additional context
You are writing tickets. Be specific. Include test plans...
```

**What dies:**

- `dist/` — moved to `.gitignore`. Build output is ephemeral; suit emits to runtime tempdirs already.
- `plugins/` — every bundle gets converted to either an outfit (large, role-shaped bundle) or an accessory (small, additive bundle). Accumulated bundles like `bones-powers` (16 skills + hooks) graduate to either: (a) one outfit per role they served, or (b) several accessories for piecemeal use. Authors decide per-bundle during the migration PR.
- `marketplace/` — APM-as-distribution is no longer the strategy; the directory is removed. The `apm/` adapter in suit stays in case wardrobe authors want to publish a specific outfit to APM in the future, but the wardrobe itself does not host marketplace metadata.
- `.agents/` — legacy path; orphan file moves to `skills/skill-creator/SKILL.md`.
- `LICENSES/` — collapsed into a single `LICENSES.md` at root if multi-license, otherwise just `LICENSE`.
- `AGENTS.md` (top-level, auto-generated) — gitignored. It's a `suit-build` output, not source.
- `SUPERPOWERS_ARCHITECTURE.md`, `GH_PROJECT_SETUP_GUIDE.md` — moved into `docs/` if still relevant; otherwise culled.

**What's preserved:**

- `.claude-plugin/` directories — when an outfit was previously a Claude Code marketplace plugin, the `.claude-plugin/manifest.json` survives at `outfits/<name>/.claude-plugin/`. The claude-code adapter already knows how to read this.
- Nested hook payloads — when a hook ships a multi-file payload (e.g. `hooks/tts-announcer/extensions/pi-tts/`), the nested layout is kept; `HOOK.md` is the single entrypoint, the rest is auxiliary content.

**APM as distribution mechanism:** dropped. The `apm/` adapter remains in suit code for future use, but the wardrobe no longer organizes itself around APM publishing. Outfits are consumed via `SUIT_CONTENT_PATH` or by cloning the wardrobe directly. If a future need for distribution emerges, it gets its own ADR.

**Component target audit:** during the wardrobe restructure, every component's `targets:` frontmatter is reviewed. Skills currently declaring `targets: [claude-code]` only are evaluated for codex/pi opt-in where the content is harness-agnostic. This is the single biggest fix for the "0 components emitted to codex" problem from the v0.3 smoke test.

## Consequences

**Positive:**
- One canonical location per primitive. Finding a skill is `wardrobe/skills/<name>/SKILL.md`. No 4-place glob.
- Outfits and accessories are first-class composition primitives, replacing the ambiguous `plugins/` concept.
- Build artifacts no longer pollute the source tree (`dist/`, top-level `AGENTS.md`).
- Multi-harness coverage improves once `targets:` frontmatter is audited.
- Documentation lives in `docs/`, not at the root next to source content.

**Negative:**
- One-shot mass move. Per-file `git mv` to preserve blame, but the diff is large. Mitigated by single coordinated PR.
- Authors of existing plugins (`bones-powers` et al.) need to make a per-bundle judgment call during the migration: does this become an outfit, or several accessories, or just flat skills?
- New top-level dirs (`rules/`, `commands/`) require the wardrobe to grow into shapes it didn't have before.

**Neutral:**
- `suit.config.yaml` keeps its current shape (adapter defaults). No changes required for the layout migration.
- The `LICENSES/` collapse is cosmetic only; doesn't affect tooling.

## Alternatives considered

**Keep `plugins/` as bundling primitive alongside outfits.** Rejected. Two ways to express the same thing (a named bundle of components) is one too many. ADR-0010's accessory primitive subsumes the small-bundle case; outfits subsume the large-bundle case.

**Keep skills nested under their owning bundle (`bones-powers/skills/...`).** Rejected. Reuse across outfits is the common case (`tdd` skill belongs with backend AND frontend); a flat shared pool with outfits referencing by name is cleaner than every outfit duplicating skills it shares.

**Lowercase `skill.md`, `agent.md`, etc. for consistency with `outfit.md`.** Rejected. `SKILL.md` is the cross-ecosystem standard (Claude Skills, Anthropic plugins). Suit's vocabulary primitives (outfit/mode/accessory) get lowercase; harness-component primitives keep the uppercase convention.

**Keep `dist/` checked in as a build cache.** Rejected. Builds are fast (`suit-build` is a single npm package); the cache adds churn to every PR and exists only because of historical workflow accidents.

**Maintain a one-version dual-read grace period (per ADR-0007's pattern).** Rejected. Internal consumer set is small (3 repos); coordinated cutover is cheaper than carrying compatibility code.

## Related

- [ADR-0010](./0010-rename-and-three-tier-composition.md) — the vocabulary rename + composition model this layout supports.
- [ADR-0001](./0001-three-repo-split.md) — the three-repo model (suit, wardrobe, suit-template) this restructure ripples through.
- [ADR-0008](./0008-content-store-deep-module.md) — content discovery; unaffected by this layout change.
