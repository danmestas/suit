# Changelog

All notable changes to `@agent-ops/suit` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
