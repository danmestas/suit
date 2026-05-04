# Changelog

All notable changes to `@agent-ops/suit` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
