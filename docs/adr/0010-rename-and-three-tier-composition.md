# ADR-0010: Rename `persona` to `outfit`, add `accessory`, expand `mode`

Date: 2026-05-04
Status: Accepted

## Context

`suit` v0.3 organizes content into two top-level concepts:

- **Persona** — a YAML manifest with `categories`, `skill_include`, `skill_exclude`. At prelaunch time, the resolver uses these fields to *filter* a global pool of skills and select which ones get emitted into the harness's tempdir.
- **Mode** — a YAML manifest with a body. The body is injected as additional context. Modes do not select components; they only flavor the prompt.

Two friction points emerged from real use:

1. **Vocabulary collision.** The tool itself is `suit`. The metaphor `apply a suit to a harness` reads naturally. The thing being applied is called `persona` — an unrelated metaphor that requires the user to mentally translate "I'm putting a suit on Claude" into "I'm filtering Claude's skills by persona." Day-to-day flag use (`--persona backend`) doesn't reinforce the suit-up metaphor that the rest of the CLI leans on.

2. **Composition is too coarse-grained.** A persona is the only way to inject configuration. If you want to keep your usual backend persona but add (say) `tracing` for one session, your options are: (a) edit the persona, (b) make a new persona, (c) `--no-filter` and lose all configuration. There is no piecemeal overlay primitive.

Modes don't help here either, because today they only carry a prompt body — they cannot pull in additional skills or rules. Authors who want a "ticket-writing" workflow have to encode the skills they need into a persona, even though those skills are workflow-specific (mode-shaped), not role-specific (persona-shaped).

## Decision

Adopt a three-primitive composition model with renamed and clarified semantics:

| Primitive | Scope | Composition role |
|---|---|---|
| **Outfit** | Complete pre-built bundle of harness-native components (skills, rules, hooks, agents, commands) | Sets the baseline component set for the session |
| **Mode** | Work-shape overlay (e.g. `ticket-writing`, `marketing`, `design`) | Extends/overrides outfit's components AND injects a prompt body |
| **Accessory** | Single piece or tiny bundle (e.g. one hook, one rule, a small skill cluster) | Repeatable add-on at invocation time, layered after outfit + mode |

**Resolution order at suit prelaunch:**

1. Start with empty component set.
2. Apply outfit → fills baseline.
3. Apply mode → merges/overrides components, plus injects mode body as additional context.
4. Apply each `--accessory <name>` flag in order → adds 1 small bundle per flag, repeatable.
5. Emit per-harness via existing adapters.

**Suit-as-translator architecture.** The wardrobe (and the suit CLI) speak `outfit`, `mode`, `accessory`. The harness emit boundary remains harness-native: claude-code still receives `.claude/skills/*/SKILL.md`, codex still receives an `AGENTS.md` with `## Skills` / `## Rules` / `## Agents` sections, pi still receives `.pi/skills/*/SKILL.md`. The translation is a deliberate part of suit's job — wardrobe vocabulary is for humans; emit vocabulary is for harnesses.

**CLI surface (v0.4):**

```text
suit <harness> [--outfit X] [--mode Y] [--accessory A] [--accessory B] [--no-filter] [-- <harness args>]
suit list <outfits|modes|accessories>
suit show <outfit|mode|accessory> <name>
```

**Schema changes:**

- `PersonaSchema` → `OutfitSchema`. Frontmatter `type: persona` → `type: outfit`.
- New `AccessorySchema`. Frontmatter `type: accessory`.
- `ModeSchema` gains an optional `include:` block declaring component overlays (skills, rules, hooks, agents, commands). Modes without an `include:` block work exactly as today (body-only injection).
- Outfit/Accessory/Mode `include:` is **strict by default**: a missing referenced component fails prelaunch with a precise error (`outfit "backend" includes skill "xyz" not found in wardrobe`).
- Resolution metadata JSON: `metadata.persona` → `metadata.outfit`. New `metadata.accessories: string[]`. `metadata.mode` unchanged.

**No migration tooling shipped.** v0.4 is a clean break. The known consumers (this monorepo's three repos: `suit`, `wardrobe`, `suit-template`) are renamed in lockstep.

## Consequences

**Positive:**
- CLI vocabulary aligns with the suit metaphor end-to-end (`suit claude --outfit backend --mode focused --accessory tracing` reads as "wear backend outfit, in focused mode, with tracing").
- Composition gains a piecemeal axis (accessory) without polluting outfits or modes.
- Modes become a first-class workflow primitive: a `ticket-writing` mode can pull in `linear-method` + `to-issues` skills directly, without authors building a one-off persona for that workflow.
- The wardrobe vs harness vocabulary boundary is now explicit: outfit/mode/accessory are suit's translation surface.

**Negative:**
- Breaking CLI change. Every script invoking `suit X --persona Y` breaks at v0.4. Mitigated by: small consumer pool (3 repos), no external users, single coordinated cutover.
- Author cognitive load increases slightly: three primitives to choose between instead of two. Mitigated by clear scope distinctions (outfit = role, mode = work-shape, accessory = piecemeal add-on).
- Conflict resolution between outfit/mode/accessory needs a documented rule (currently: dedupe by component name, last-application-wins, log on `--verbose`).

**Neutral:**
- Adapters (claude-code, codex, gemini, copilot, apm, pi) need only mechanical edits (the per-target `case 'persona': return []` no-op clauses become `case 'outfit'` and add a `case 'accessory'`). No semantic change to emit logic.
- Backwards compatibility window: none. The grace pattern from ADR-0007 (dual-path-read) is not applied here because the user audience is internal.

## Alternatives considered

**Keep `persona`, just add `accessory`.** Rejected. Doesn't fix the suit-metaphor mismatch, only makes it worse by adding a wardrobe-flavored noun next to a non-wardrobe noun.

**Rename `persona` to `kit`.** Rejected. Semantically fine but breaks metaphor (kit reads as "toolkit/SDK," dev-tooling overload).

**Rename `skill` to `accessory` too.** Rejected. Skills are the harness primitive (Claude Code's filesystem layout, Codex AGENTS.md sections all use "Skills"). Renaming upstream would force suit to translate the noun at the emit boundary, and would clash with the broader Anthropic plugin ecosystem where SKILL.md is canonical. The vocabulary boundary belongs at suit-prelaunch, not at the per-component level.

**Soft `include:` (warn but don't fail on missing components).** Rejected. Strict-by-default catches typos at the earliest point and avoids silent partial-config failures during a real session.

## Related

- [ADR-0011](./0011-wardrobe-layout-v2.md) — the wardrobe directory restructure that lands alongside this rename.
- [ADR-0001](./0001-three-repo-split.md) — the three-repo model (suit, wardrobe, suit-template) this rename ripples through.
- [ADR-0007](./0007-path-migration-policy.md) — prior breaking-change pattern; reference for what we're *not* doing this time (no grace period).
