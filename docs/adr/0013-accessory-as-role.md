# ADR-0013: Accessory-as-role — promote any wardrobe component to layered accessory

Date: 2026-05-04
Status: Accepted

## Context

ADR-0010 introduced `accessory` as the piecemeal layered overlay applied via `--accessory <name>` after outfit + mode. The current resolver (`suit/src/lib/accessory.ts`) only searches `accessories/` directories across the 3-tier discovery, and the schema requires frontmatter `type: accessory`. Every accessory must therefore exist as a discrete bundle with its own `accessory.md`.

In practice, the things users actually want to layer at invocation time are usually *already* first-class wardrobe components:

- Adding TDD discipline → the `test-driven-development` skill already exists.
- Pinning the PR policy → the `pr-policy` rule already exists.
- Wiring up tracing → the `tracing` hook already exists.
- Pulling in a reviewer → the `observability-engineer` agent already exists.

Forcing the author to also create a 1-component `accessories/<x>/accessory.md` wrapper that does nothing but `include: { skills: [<x>] }` is friction that discourages composition. The wardrobe v3 restructure (`docs/plans/wardrobe-restructure-v3.md`) made this concrete: of the 10 accessories proposed during planning, 6 were 1-component wrappers around an existing skill or hook. That ratio is a clear signal the model is too rigid.

`accessory` was meant to be the cheap, repeatable axis of composition. Today it's the most expensive primitive to author.

## Decision

Widen `findAccessory(name, dirs)` in `suit/src/lib/accessory.ts` to fall through additional primitive directories when no accessory bundle matches. Within each tier (project / user / wardrobe), search order is:

```text
accessories/  →  skills/  →  hooks/  →  rules/  →  agents/  →  commands/
```

First match wins. Tier precedence is unchanged (project > user > wardrobe). Within a tier, `accessories/X/` always wins over `skills/X/` if both exist.

**Synthesis on non-accessory match.** When the resolver finds a match in `skills/`, `hooks/`, `rules/`, `agents/`, or `commands/`, it synthesizes a phantom `AccessoryManifest` whose `include` block contains only that one component. Matching a skill named `test-driven-development` produces:

```yaml
type: accessory
name: test-driven-development
include:
  skills: [test-driven-development]
```

The phantom carries `type: 'accessory'` literally so it satisfies the schema downstream, and the resolver's `AccessoryManifest` invariant is preserved — `validateIncludes` in `resolution.ts` is unchanged and validates synthesized include blocks the same way as authored ones.

**`FoundAccessory` gains a `synthetic: boolean` flag.** Downstream `suit show` and `suit list` use it to distinguish phantoms from authored bundles.

**`listAllAccessories(dirs)` is unchanged.** Listing only enumerates real bundles in `accessories/`. Singleton fall-through is a per-name resolution behavior, not a discovery one. Authoring a real `accessory.md` is still meaningful: you bundle multiple components and add a description body.

**No CLI surface change.** `--accessory <name>` syntax is identical; only the resolver widens.

**No ambiguity-prefix syntax.** `--accessory skill:X` is not introduced. Same-named collisions across primitive dirs are rare in the current wardrobe, and the deterministic precedence rule (accessory > skill > hook > rule > agent > command) is sufficient. If collisions become common, a future ADR adds prefix syntax.

**Before / after.**

Pre-0.6, layering the TDD skill required:

```text
wardrobe/accessories/tdd/accessory.md
---
name: tdd
include:
  skills: [test-driven-development]
---
```

```sh
suit claude --outfit backend --accessory tdd
```

Post-0.6, the wrapper is gone:

```sh
suit claude --outfit backend --accessory test-driven-development
```

The skill at `wardrobe/skills/test-driven-development/SKILL.md` is the resolution target directly.

## Consequences

**Positive:**
- Zero-friction layering of one skill / hook / rule / agent / command. The most common composition case stops requiring a wrapper file.
- Wardrobe authoring drops a category of dead boilerplate. Wardrobe v3 expects to delete ~6 of 10 planned accessories outright.
- Composition is denser: `--accessory tracing --accessory pr-policy --accessory test-driven-development` reads naturally and resolves without any `accessory.md` plumbing.
- Existing components automatically gain `--accessory` reachability without a migration step. No frontmatter edits, no renames.

**Negative:**
- `--accessory <name>` lookup grows from 1 dir to up to 6 dirs per tier (worst case 18 readdirs across all 3 tiers). Negligible: a handful of milliseconds, and FS scans for tier roots are already done during outfit/mode/skill discovery.
- Collision risk between a same-named accessory bundle and a singleton component (e.g. `accessories/tracing/` and `hooks/tracing/`). Mitigated by deterministic precedence — accessory wins. Documented in §Alternatives so authors know.

**Neutral:**
- Schema unchanged. Existing `accessory.md` files still parse and resolve identically. Pre-0.6 sessions with a real accessory bundle resume with no behavior change.
- `validateIncludes` in `resolution.ts` is unchanged. Synthesized include blocks go through the same validation path as authored ones.
- `suit list accessories` continues to enumerate only real bundles. Discovering "what can I pass to `--accessory`" expands from "list accessories" to "list accessories + list skills + list hooks + list rules + list agents + list commands." This matches user mental model — they already know the singleton names.

## Alternatives considered

**Status quo (require `accessory.md` wrappers).** Rejected. Adds authoring friction for the most common case (layering one skill or hook). Wardrobe v3 hit this directly: 6 of 10 proposed accessories were single-component wrappers.

**Prefix syntax (`--accessory skill:X`, `--accessory hook:Y`).** Rejected for now. Adds CLI complexity to disambiguate a case that's currently hypothetical. The deterministic precedence rule covers the actual wardrobe today. Can be added in a future ADR if collisions become common.

**Promote arbitrary components without synthesis (carry the original manifest).** Rejected. The resolver assumes `AccessoryManifest` shape — specifically the `include` block. Synthesis preserves the resolver invariant without widening internal types or branching downstream code paths.

**Introduce a new `--with <name>` flag for singletons.** Rejected. Splits the user model into two near-identical flags. One flag, one mental model — `--accessory` already means "layer this on top." Adding `--with` would force users to learn two ways to do the same thing.

## Related

- [ADR-0010](./0010-rename-and-three-tier-composition.md) — original accessory concept; this ADR amends its resolver behavior without changing schema or CLI.
- [ADR-0011](./0011-wardrobe-layout-v2.md) — wardrobe layout that makes singleton primitive dirs first-class, enabling fall-through.
- `wardrobe/docs/plans/wardrobe-restructure-v3.md` — the restructure plan whose accessory inventory motivated this change.
