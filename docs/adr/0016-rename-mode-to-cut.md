# ADR-0016: Rename `mode` to `cut`

Date: 2026-05-04
Status: Accepted

## Context

ADR-0010 settled the v0.4 vocabulary at three primitives — **outfit**, **mode**, **accessory** — and grounded the CLI in a tailoring/clothing metaphor (`suit up`, `suit off`, the binary itself is `suit`). Two of the three primitives carry that metaphor crisply: an outfit is a complete bundle, an accessory is a small repeatable add-on. `mode`, by contrast, is a generic CS noun. It carries no clothing connotation and reads as engineering-speak imported from systems (sandbox mode, dry-run mode, plan mode, debug mode). When the CLI says `--mode focused` the user has to mentally translate "this is the work-shape overlay primitive" — the name doesn't pull its weight.

The mismatch shows up most often in three places:

1. **Help text and onboarding.** A new user reading `--mode <name>` cannot guess from the noun what kind of thing it is. They can guess `--outfit backend` (a bundle of dev defaults) and `--accessory tracing` (a small add-on). `--mode focused` reads as "set Claude's mode to focused" — abstract, not metaphor-aligned.
2. **Search/grep collisions.** `mode` is one of the most-overloaded words in any codebase (file mode/permission bits, sandbox mode, plan mode, dry-run, mode-aware logic, the `mode` JSON key in third-party APIs). Every search for the suit primitive returns dozens of false positives. Renaming to a clothing-specific noun eliminates this.
3. **Documentation drift.** ADRs, CHANGELOG entries, help text, and README all keep slipping into "mode" the generic sense vs "mode" the suit primitive without disambiguation. The conflation has cost reader-time on every doc PR since v0.4.

`cut` is a tailoring term of art (a tailored cut, a slim cut, a relaxed cut) that means exactly what the suit primitive does: a *shape* that an outfit is tailored *to* for a particular use. It slots into the metaphor cleanly — `suit claude --outfit backend --cut focused --accessory tracing` reads as "wear backend outfit, in focused cut, with tracing." The vocabulary now reinforces itself end-to-end.

## Decision

Rename `mode` to `cut` everywhere the name refers to the work-shape composition primitive. This is a clean break, mirroring ADR-0010's persona→outfit precedent: no migration tooling, no back-compat aliases, single coordinated cutover across `suit`, `wardrobe`, and `suit-template`.

Concretely:

- **Schema.** `ModeSchema` → `CutSchema`. `ModeManifest` → `CutManifest`. Frontmatter `type: mode` → `type: cut`. The discriminated union member is updated in lockstep. The schema rejects manifests with `type: 'mode'` outright — there is no transitional acceptance window.
- **CLI.** `--mode <name>` → `--cut <name>`, on every entry point that parsed it (`suit up`, `suit <harness>`). `suit list <outfits|modes|accessories>` → `suit list <outfits|cuts|accessories>`. `suit show <outfit|mode|accessory>` → `suit show <outfit|cut|accessory>`. The CLI rejects `--mode` and the old subcommand strings — no alias.
- **Filesystem.** Wardrobe directory `modes/` → `cuts/`. Per-component file `mode.md` → `cut.md`. Project-overlay `.suit/modes/` → `.suit/cuts/`. User-overlay `<userDir>/modes/` → `<userDir>/cuts/`.
- **Resolver.** `ResolveOptions.mode` → `cut`. `modeBody` → `cutBody`. `Resolution.metadata.mode` → `metadata.cut`. `Resolution.modePrompt` → `cutPrompt`. The validator's `speaker: 'mode' | 'accessory'` → `speaker: 'cut' | 'accessory'`; error messages now read `cut "X" includes ...`.
- **Lockfile.** `.suit/lock.json`'s `resolution.mode` field → `resolution.cut`. The lockfile schema rejects the old key. `suit current` and `suit off` read the new field.
- **Adapter no-ops.** Every adapter's `case 'mode': return []` clause → `case 'cut': return []`.
- **Compatibility matrix.** `validate.ts`'s MATRIX entry `mode:` → `cut:`. The body-size warning/error wording (`mode body too long`) → `cut body too long`.
- **COMPONENT_TYPES.** The literal `'mode'` in `src/lib/types.ts` → `'cut'`.
- **Help, README, CHANGELOG, ADRs.** Documentation references to the primitive renamed; ADR-0010, ADR-0011, ADR-0013 carry historical references that read fine in context (the rename is reported here, not retroactively edited into prior ADRs).

Suit's package version moves to **0.9.0** to mark the breaking surface change. Wardrobe and suit-template land coordinated renames at the same time.

## Consequences

**Positive:**
- The CLI vocabulary now reinforces the suit/tailoring metaphor end-to-end. `--outfit`, `--cut`, `--accessory` all read as clothing terms of art.
- Code search for the suit primitive is no longer drowned in false positives from generic uses of `mode` (file mode, sandbox mode, plan mode, JSON `mode` keys).
- Help text reads more naturally; the per-flag noun gives the user a stronger guess about its role.
- ADR-0010's vocabulary discipline is restored — three primitives, three clothing nouns, no exceptions.

**Negative:**
- Breaking schema/CLI/lockfile change. Any external script invoking `suit X --mode Y` or any wardrobe authored with `type: mode` breaks at v0.9. Mitigated by the same factors as ADR-0010: small consumer pool (this monorepo's three repos), no external users, single coordinated cutover.
- One more rename in CHANGELOG history. Grep-archeology of older suit branches now requires knowing that `mode` and `cut` are the same primitive.

**Neutral:**
- Resolver semantics are unchanged. The composition order (outfit → cut → accessories), the include-block validation, the categories intersection, the body-as-prompt injection — all identical to v0.8. This is a vocabulary rename, not a behavior change.
- Adapter emit logic is unchanged. The per-target `case 'cut': return []` clauses are mechanical replacements for the old `case 'mode': return []`.
- File-mode and unrelated `mode` references (file permission bits, dry-run/sandbox/plan modes, third-party API keys) are untouched and remain as they were.

## Alternatives considered

**`fit`.** Rejected. Semantically the closest alternative ("a slim fit," "the fit of this jacket"), but it's also a colloquialism ("does this fit your needs?", "best fit for the role") that bleeds into non-tailoring contexts. `cut` is more specific to tailoring and reads as a single, unambiguous noun.

**`silhouette`.** Rejected. Crisp meaning ("the silhouette of a suit") but six syllables, awkward to type as a CLI flag, and reads as visual/aesthetic rather than functional.

**`stance`.** Rejected. Carries the right shape-of-engagement connotation but isn't a clothing noun — it pulls the metaphor toward martial-arts/posture vocabulary instead of tailoring.

**Keep `mode`, accept the conflation.** Rejected. The friction is recurring; every doc PR pays it. Renaming once costs less total than living with the mismatch.

**Add a soft alias period (`--mode` accepted with a deprecation warning for one release).** Rejected, mirroring ADR-0010 §"No migration tooling shipped." The user audience is internal and small; a clean break has lower long-term cost than a transitional window's complexity.

## Related

- [ADR-0010](./0010-rename-and-three-tier-composition.md) — the persona→outfit precedent and the three-primitive composition model this rename keeps intact.
- [ADR-0011](./0011-wardrobe-layout-v2.md) — the wardrobe directory layout (`outfits/`, `modes/`, `accessories/`) that v0.9 updates to `outfits/`, `cuts/`, `accessories/`.
- [ADR-0013](./0013-accessory-as-role.md) — the accessory-as-role fall-through, unchanged by this rename.
