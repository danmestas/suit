# Changelog

All notable changes to `@agent-ops/suit` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.0] — 2026-05-10

Drops the `apm` and `copilot` adapters and removes them from the public `TARGETS` enum. Coordinates with the [danmestas/wardrobe](https://github.com/danmestas/wardrobe) tier-of-support reframe: bulletproof Claude Code, well-supported Codex / Gemini / Pi, DIY-from-docs anything else. APM was scaffolded but never shipped (no published packages, no consumer); Copilot has no ongoing investment.

### Removed

- **`apm` target** — dropped from `TARGETS` literal in `src/lib/types.ts`. Removes `src/adapters/apm.ts` adapter; prunes the `apm` entry from `src/adapters/index.ts` REGISTRY. Removes `publishAPM` and the `APMReleaseOptions` type from `src/lib/release/publish.ts`; narrows `runRelease` (drops `apmToken` / `runApm` options, drops `published.apm` result field). Removes the `APM_TOKEN` env-var read and the `apm` plumbing from `cli.ts releaseCmd`. Drops `apm` from `HARNESS_BINS`, `HARNESS_ALIASES`, `binNames`, the `LAYOUTS` table in `harness-catalog.ts`, the `TARGET_PROJECT_PREFIX` and `TARGET_SUBDIRS` / `TARGET_SKILLS_SUBDIR` records, and the type-by-target compatibility matrix in `validate.ts`. Removes `prelaunchComposeApm` from `src/lib/ac/prelaunch.ts` and the `case 'apm'` arm + `apmPackageDir` field from `session.ts`. (#58)
- **`copilot` target** — same scope as APM. Removes `src/adapters/copilot.ts` and the `composeCopilotInstructions` export. Removes `src/lib/harness-adapters/copilot.ts` and the `GH_COPILOT_CLI` detection branch from the harness-adapters index. Drops the copilot branch from the `docs` subcommand in `cli.ts`. Drops `copilot` from `GIT_URL_TARGETS` in `notes.ts` and the friendly-name special case. Removes `prelaunchComposeCopilot` from `src/lib/ac/prelaunch.ts` and the `case 'copilot'` arm from `session.ts`. (#58)
- **`src/tests/adapters/apm/` + `src/tests/adapters/copilot/`** test fixture trees plus the `*.test.ts` orchestrators, `src/tests/release/publish-apm.test.ts`, and `src/tests/integration/ac-prelaunch-apm.test.ts`. (#58)

### Migration

- If your `suit.config.yaml` declares an `apm:` or `copilot:` block, remove it. They no longer parse to anything.
- If a SKILL.md frontmatter `targets:` list includes `apm` or `copilot`, remove those entries — Zod validation at `discover` time will reject them.
- If a release flow passed `APM_TOKEN` / `runApm` / `apmToken` to `runRelease`, drop those — the API no longer accepts them.
- Wardrobe's `npx -y -p @agent-ops/suit suit-build` invocations gain no new flags — the change is purely subtractive.

## [0.12.0] — 2026-05-09

External-orchestrator integration polish: five focused improvements to `suit prepare` driven by an end-to-end audit of the `agent-harness` integration. Friction was triaged across spike, Ousterhout review, and stasi transcript audit before each change landed.

### Added

- **`suit prepare --shape sidecar`** emits a side-loadable bundle plus a generated `launch` bash script that owns the recipe. Caller does `exec $BUNDLE/launch` instead of assembling 4–5 flags. Solves the latent gap where the project-shape recipe (`cwd=$BUNDLE && claude --add-dir $PROJECT`) silently misses the project's own CLAUDE.md (Claude Code's `--add-dir` doesn't walk for CLAUDE.md auto-discovery, only grants tool access — verified via spike). Sidecar shape requires `--target claude-code` and `--project <path>`. (#44, #56)
- **`suit prepare --label <text>`** stamps the bundle with caller-provided metadata (e.g. `agent-harness/bones-worker-3`) for registry surveys. (#43, #54)
- **`.suit-bundle.json`** introspection metadata at every bundle root: `{ schemaVersion, outfit, cut, accessories, target, label?, shape?, suitVersion, generatedAt }`. (#43, #54)
- **`suit show bundle <path>`** pretty-prints `.suit-bundle.json`. (#43, #54)
- **`suit list accessories --resolvable`** (and `--include-fall-through`) widens listing to the full `--accessory` resolvable surface — authored bundles + fall-through skills/hooks/rules/agents/commands. Single sorted column with `[kind]` annotations; authored wins precedence on collision. (#49, #53)
- **`suit prepare --quiet`** trims the trailing newline from stdout so `BUNDLE=$(suit prepare ... --quiet)` captures cleanly. Suppresses informational stderr in the success path. (#48, #52)
- **`suit prepare --dry-run`** previews the file list (`<path>\t<size>\t<sourceComponent>` per line) without writing a bundle. (#47, #52)
- **`--target claude` alias** for `--target claude-code`. Internal `Target` type unchanged; alias is resolved at parse time. Eliminates a translation step in every wrapper. (#50, #52)
- **`suit doctor`** expanded with 5 checks: content-path, globals (claude) staleness, lockfile consistency, wardrobe staleness (FETCH_HEAD age), and harness presence (preserved v0 behavior). Per Ousterhout review on the issue: straight-line implementation, not a `Check[]` framework. (#46, #55)

### Changed

- **Singleton CLI flags reject duplicates** instead of silently last-wins. `suit prepare --outfit X --outfit Y` now exits 2 with a clear error. `--accessory` is repeatable but deduplicates same value with a warning. Catches caller bugs in programmatic invocations. (#45, #52)

### Fixed

- **Tmpdir comment in `prepare.ts` JSDoc** was wrong on macOS. Now references `<os.tmpdir()>` with platform examples. (#51, #52)

### Implementation notes

- All changes shipped through PRs #52, #53, #54, #55, #56 — small, reviewable, sequentially mergeable.
- Test count: 543 → 567 (24 new across the five PRs).
- No breaking changes; v0.11.x recipes continue to work unchanged.

## [0.9.0] — 2026-05-04

Renames the work-shape composition primitive from `mode` to `cut`. Mirrors the persona→outfit precedent from ADR-0010 — clean break, no migration tooling, single coordinated cutover across `suit`, `wardrobe`, and `suit-template`. Resolver semantics unchanged; this is a vocabulary rename, not a behavior change.

### BREAKING

- **`mode` → `cut`** across schema, CLI, lockfile, filesystem, and resolver. Every `--mode` flag, `ModeSchema`, `type: mode` frontmatter, and `modes/` directory has been renamed. No backwards-compatible alias is provided. ([ADR-0016](docs/adr/0016-rename-mode-to-cut.md))
- **Schema**: `ModeSchema` → `CutSchema`; `ModeManifest` → `CutManifest`; frontmatter `type: mode` → `type: cut`. The discriminated union member is updated in lockstep.
- **CLI**: `--mode <name>` → `--cut <name>` on every entry point (`suit up`, `suit <harness>`). `suit list <outfits|modes|accessories>` → `suit list <outfits|cuts|accessories>`. `suit show <outfit|mode|accessory>` → `suit show <outfit|cut|accessory>`.
- **Filesystem**: wardrobe `modes/` → `cuts/`; per-component file `mode.md` → `cut.md`; project-overlay `.suit/modes/` → `.suit/cuts/`; user-overlay `<userDir>/modes/` → `<userDir>/cuts/`.
- **Resolver**: `ResolveOptions.mode` → `cut`; `modeBody` → `cutBody`; `Resolution.metadata.mode` → `metadata.cut`; `Resolution.modePrompt` → `cutPrompt`; error messages now read `cut "X" includes ...`.
- **Lockfile**: `.suit/lock.json`'s `resolution.mode` → `resolution.cut`. The lockfile schema rejects the old key.
- **Adapters**: every adapter's `case 'mode': return []` clause → `case 'cut': return []`.

### Migration

There is **no automatic migration path**. Authors of wardrobes / suit-template forks should rename `modes/` → `cuts/` and `mode.md` → `cut.md`, and update frontmatter `type: mode` → `type: cut`, in lockstep with this release. See ADR-0016 for the full rationale and ADR-0010 for the precedent.

### Companion releases

- **wardrobe**: parallel rename to v5 (filesystem layout + manifests).
- **suit-template**: parallel rename.

## [0.5.3] — 2026-05-04

### Added

- **`suit status` reports wardrobe staleness.** Best-effort `git fetch` against the cached wardrobe; when it's behind origin, prints `Wardrobe: N commits behind <upstream> (run \`suit sync\` to update)`. Happy path stays quiet — line is omitted when the cache is current. Offline / network failure is silently tolerated (status still works without complaint). Bounded by `GIT_HTTP_LOW_SPEED_*` so a slow/dead remote can't make `suit status` hang.

### Implementation notes

- `ContentStore.status()` takes an optional `{ checkRemote?: boolean }`; when true, populates the `SyncState` slot with `{ ahead, behind, upstream, lastFetchAt }` (the type was already declared but unwired in v0.5.x).

## [0.5.2] — 2026-05-04

Tiny follow-up to v0.5.1.

### Fixed

- `suit off` now restores `CLAUDE.md` to its **byte-exact** pre-`suit up` state. Previously, stripping the marker block left an extra trailing newline when the block had been at end-of-file. Logically the user content was preserved, but the file's sha256 differed from the original — noisy in `git diff` for projects committing `CLAUDE.md`. One-character fix in `stripSuitBlocks` (replace match with `''` instead of `'\n'`; the regex already captures the leading newline).

## [0.5.1] — 2026-05-04

Fixes two real problems surfaced by the v0.5.0 e2e battery: hooks didn't fire under `suit up` (the settings fragment landed at a path Claude doesn't read), and `suit up` would clobber any user-authored project `CLAUDE.md`.

### Fixed

- **Settings fragment path** under `suit up`: `.claude/settings.fragment.json` is now redirected on disk to `.claude/settings.local.json`, which Claude Code reads natively. Hooks defined in outfits/accessories now fire when you invoke `claude` natively in a `suit up`-dressed project. Same redirect for `.gemini/settings.fragment.json` → `.gemini/settings.json`. The launcher (`suit <harness>`) keeps the fragment-path emit because `suit-build` merges it explicitly during prelaunch.
- **`CLAUDE.md` is additive, not replace.** `suit up` now wraps the active outfit body (and the active mode body, if any) in a `<!-- suit:outfit:NAME -->...<!-- /suit:outfit:NAME -->` marker block and appends it to whatever `.claude/CLAUDE.md` already exists. Pre-existing user content is preserved verbatim. `suit off` strips just the marker block, leaving user content in place. If only the marker block existed, the file is removed; if user content remains, the file stays. The block sha256 is what the lockfile records (not whole-file hash) — drift detection refuses on hand-edited blocks unless `--force`.

### Added

- `LockEntry.mode: 'replace' | 'additive'` — schema-supported (optional; absent means `'replace'` for back-compat with v0.5.0 lockfiles).
- `ProjectWriter.writeAdditive` for marker-block append semantics, exported `isAdditivePath` and `stripSuitBlocks` helpers used by `suit off`.

### Reused

- The outfit's existing markdown body is what goes inside the marker block — no wardrobe content changes needed. Authors who want richer per-outfit rules can edit `outfits/<name>/outfit.md` body directly.

## [0.5.0] — 2026-05-04

Adds a second mode of working — project-state mutator (`suit up` / `suit off` / `suit current`) — and **promotes it to the standard daily-driver flow**. The original stateless launcher (`suit <harness>`) remains, repositioned as the one-off escape hatch for sessions where you specifically don't want to dress the project.

### Added

- **`suit up`** — dresses the project filesystem with the resolved outfit + mode + accessories. Writes per-harness components into `.claude/`, `.codex/`, `.pi/`, etc. and persists `.suit/lock.json`. Native `claude` / `codex` / `pi` invocations from inside the dressed project pick the suit up automatically. ([ADR-0012](docs/adr/0012-suit-up-and-suit-off.md))
- **`suit off`** — reads `.suit/lock.json`, removes every tracked file (verifying sha256), removes empty parent dirs, deletes the lockfile. Idempotent.
- **`suit current`** — read-only inspector. Reports applied resolution, file count, sample paths. Detects drift (hand-edited tracked files) as informational.
- **Interactive picker** — `suit up` invoked on a TTY without `--outfit` prompts numbered list of outfits → modes → accessories. No new dependency (uses Node's `readline/promises`).
- **JSON fragment merge** — when multiple components emit the same JSON path (e.g. `.claude/settings.fragment.json` from each hook), suit deep-merges the contents instead of refusing on byte-mismatch. Markdown emits stay non-mergeable (a real authoring bug).

### Changed

- **Strict refuse-when-dirty merge** for `suit up`: refuses on (1) target file exists and isn't tracked, (2) tracked file's sha256 doesn't match what was recorded (hand-edited), or (3) prior lockfile records a different resolution. `--force` overrides each.
- Internal: introduced a `Writer` abstraction (`src/lib/writer.ts`) so the same emit chain writes to either a tempdir (`TempdirWriter`, used by the stateless launcher) or a project root (`ProjectWriter`, used by `suit up`). Refactored `prelaunch.ts` to consume the abstraction; public contract preserved.
- Internal: `lockfile.ts` self-contained data layer with sha256 helpers (`crypto.createHash`, no new dep).

### Companion releases

None — v0.5 is a suit-only release. Wardrobe and suit-template contents work unchanged against both the stateless launcher and the new mutator.

### Reserved for future (not in v0.5)

- `--ephemeral` flag on `suit <harness>` to force per-session even when project is dressed
- `--target <harness>` to scope `suit up` to one adapter
- `--refresh` on `suit up` to re-apply after wardrobe sync
- Three-way merge (vs the current strict refuse-when-dirty)

## [0.4.0] — 2026-05-04

Major composition-model overhaul. Renames the primary configuration primitive and introduces a third composition layer.

### BREAKING

- **`persona` → `outfit`** across the CLI, schema, and content layout. Every \`--persona\` flag, \`PersonaSchema\`, \`type: persona\` frontmatter, and \`personas/\` directory has been renamed. No backwards-compatible alias is provided. ([#11](https://github.com/danmestas/suit/pull/11), [ADR-0010](docs/adr/0010-rename-and-three-tier-composition.md))
- **Resolution metadata key**: \`metadata.persona\` → \`metadata.outfit\` in the resolved JSON.
- **Subcommands**: \`suit list personas\` → \`suit list outfits\`; \`suit show persona <name>\` → \`suit show outfit <name>\`. The list/show kind union now accepts \`'outfit' | 'mode' | 'accessory'\`.

### Added

- **Accessory primitive** — small, named, repeatable add-ons applied via \`--accessory <name>\` (repeatable). Each accessory declares an \`include:\` block listing components to layer over outfit + mode at invocation time. Strict-include semantics: a missing referenced component fails prelaunch with a precise error. ([#12](https://github.com/danmestas/suit/pull/12), [ADR-0010](docs/adr/0010-rename-and-three-tier-composition.md))
- **Mode component overlays** — modes can now declare a structured \`include:\` block alongside their prompt body. A mode like \`ticket-writing\` can pull in \`linear-method\` + \`to-issues\` skills directly. Body-only modes (the v0.3 shape) continue to work unchanged. ([#13](https://github.com/danmestas/suit/pull/13))
- **`suit list accessories`** and **`suit show accessory <name>`** subcommands.
- **Per-type filename discovery** — \`AGENT.md\`, \`HOOK.md\`, \`RULES.md\` are recognized in their respective dirs (with \`SKILL.md\` fallback for back-compat). Skills retain \`SKILL.md\` (cross-ecosystem standard). ([#14](https://github.com/danmestas/suit/pull/14))
- **Flexible TAXONOMY.md path** — validate now reads \`TAXONOMY.md\` from repo root or \`docs/TAXONOMY.md\`; precise error if both are absent.
- **Realtime e2e Docker harness** — interactive container at \`src/tests/integration/docker/Dockerfile.realtime\` + \`run-realtime.sh\`. Pulls Claude OAuth from Keychain, Codex auth from \`~/.codex/\`, OpenRouter API key from Doppler. Three-harness PONG smoke test confirmed. ([#9](https://github.com/danmestas/suit/pull/9))

### Changed

- Resolution order is now formally **outfit → mode → accessories**. Each layer can force-include components by name; later layers override earlier ones for filtering.
- Adapter switch statements gain a \`case 'accessory': return [];\` no-op clause across all six adapters (claude-code, codex, gemini, copilot, apm, pi). Accessories are harness-agnostic and consumed at resolve time.
- README.md and docs/USAGE.md updated to use outfit / mode / accessory vocabulary throughout.

### Companion releases

- **wardrobe** (formerly **agent-config**): renamed and restructured to layout v2. \`personas/\` → \`outfits/\`, plugin bundles flattened, one canonical location per primitive. ([wardrobe#98](https://github.com/danmestas/wardrobe/pull/98))
- **suit-template**: parallel restructure of the public starter content repo. ([suit-template#1](https://github.com/danmestas/suit-template/pull/1))

### Migration

There is **no automatic migration path**. The known consumer set (this monorepo's three repos) was renamed in lockstep. Authors of forked content repos should:

1. Rename \`personas/\` → \`outfits/\`, frontmatter \`type: persona\` → \`type: outfit\`.
2. Update \`--persona\` flags in scripts to \`--outfit\`.
3. Optionally adopt \`accessories/\` for piecemeal overlays.

See the wardrobe restructure PR for a worked example.

## [0.3.0] — earlier

Removed legacy support for `~/.config/agent-config/` and `.agent-config/` paths. See [ADR-0007](docs/adr/0007-path-migration-policy.md).
