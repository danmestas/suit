# ADR-0014: User-scope globals registry + outfit-as-targeting

Date: 2026-05-04
Status: Accepted

## Context

By v0.6, the wardrobe owns first-class composition primitives (outfits, modes, accessories) that select skills/rules/hooks/agents/commands from the wardrobe content pool. But every real session also depends on **external tooling at user scope** that the wardrobe doesn't see: Claude Code marketplace plugins (`superpowers`, `obsidian`, `mgrep`, `context-mode`, …), MCP servers configured in `~/.claude.json` (axiom, signoz, github, doppler, …), and globally-installed hooks. Today these are loaded indiscriminately on every session — there is no way for an outfit to declare "this domain doesn't need the Linear MCP" or for an accessory to layer on a specific tool just for this invocation.

Two real constraints shape this:

1. **The user installs everything globally on purpose.** A `Brewfile` model: install once, use across all projects. Per-project install is friction the user has explicitly rejected. Suit must not become a package manager.
2. **Different sessions need different subsets.** A frontend session shouldn't see backend MCPs. A debugging session shouldn't see ticket-writing tools. Loading everything everywhere bloats context and dilutes the harness's attention.

A third concern surfaced during scoping: external acquisition (`suit add plugin`) couples suit to per-harness package-manager semantics. We're rejecting that responsibility for now — the user installs externally however they want, and suit's job is *targeting*, not *acquisition*.

## Decision

**Wardrobe owns a registry; suit owns the runtime filter; outfits/modes/accessories own the targeting policy.**

### 1. `globals.yaml` registry (in wardrobe)

A hand-synced (via tooling) snapshot of every globally-installed plugin and MCP at user scope on each machine. Source of truth for "what exists." Committed to the wardrobe repo so multiple machines converge through PRs.

```yaml
schemaVersion: 1
generated_at: 2026-05-04T18:30:00.000Z
machine: dans-mbp
plugins:
  superpowers:
    source: claude-code-marketplace
    install: claude plugin install superpowers
    discover_path: ~/.claude/plugins/cache/claude-plugins-official/superpowers/1.4.0
    version: 1.4.0
  obsidian:
    source: manual
    install: claude plugin install obsidian
    discover_path: ~/.claude/plugins/cache/obsidian-skills/obsidian/1.0.0
    version: 1.0.0
mcps:
  signoz:                       # stdio MCP
    source: claude-code-config
    type: stdio
    command: signoz-mcp-server
    has_env: true               # presence flag; env values stay in ~/.claude.json
    discover_path: ~/.claude.json#mcpServers.signoz
  axiom:                        # http MCP
    source: claude-code-config
    type: http
    url: https://mcp.axiom.co/mcp
    has_headers: true           # presence flag; header values stay in ~/.claude.json
    discover_path: ~/.claude.json#mcpServers.axiom
hooks: {}
```

### 2. `suit-build sync-globals` command

```
suit-build sync-globals [--out <path>] [--pr] [--dry-run]
```

Reads `~/.claude/plugins/installed_plugins.json` (filtering to user-scope entries; project-scope plugins are not globals) and `~/.claude.json mcpServers` (both stdio and http transports), computes the registry, writes to `globals.yaml`. With `--pr`, creates a branch + commits + opens a wardrobe PR — the canonical multi-machine convergence flow. The user runs this manually (or via a SessionStart hook) when they install or remove a tool at user scope.

MCP entries record non-secret metadata only. For stdio MCPs that's `command`, `args`, and a `has_env` flag; for HTTP MCPs (Claude Code's `type: http` shape) that's `url` and a `has_headers` flag. The actual env values (stdio) and header values (http) — which routinely contain bearer tokens — stay in `~/.claude.json` and never enter the committed registry.

The wardrobe exposes this as `npm run sync-globals` (delegates to `suit-build sync-globals`), matching how other wardrobe scripts already delegate.

### 3. `enable:` / `disable:` blocks on outfits, modes, accessories

A new optional sub-schema added to `OutfitSchema`, `ModeSchema`, `AccessorySchema`:

```yaml
enable:
  plugins: []
  mcps: []
  hooks: []
disable:
  plugins: []
  mcps: []
  hooks: []
```

Both fields optional. Empty by default. Names reference entries in `globals.yaml`.

**Authorial guidance:** outfits and modes own the broad enable/disable lists ("backend doesn't need Linear / Jira"); accessories are piecemeal — typically one item enabled or disabled per accessory ("layer the tracing MCP onto this session").

### 4. Resolution semantics (in `resolve()`)

- **Baseline** = all names from `globals.plugins`, `globals.mcps`, `globals.hooks` from the loaded registry.
- **Layer order**: outfit → mode → accessories (in CLI / declaration order).
- For each layer:
  1. Apply `layer.disable.<kind>` → remove names.
  2. Apply `layer.enable.<kind>` → add (or re-add if previously dropped) names.
- The final kept-set propagates into `Resolution.metadata.globals.{plugins,mcps,hooks}.{kept,dropped}`.
- A reference in `enable.<kind>` that doesn't exist in `globals.yaml` is recorded under `metadata.globals.<kind>.unresolved`, logged via stderr, and skipped (not a fatal error).

### 5. Symlink-farm enforcement (HOME-override mechanism)

Phase A research confirmed Claude Code respects `HOME` override — already how suit's existing skill filter works (`session.ts:133` spawns the harness with `HOME=<tempHome>`). Phase D extends `composeHarnessHome` to honor the resolved kept-sets:

- **Plugins**: `~/.claude/plugins/` is no longer symlinked as a single directory. The tempdir gets a real `.claude/plugins/` dir with symlinks only to the plugin subdirs in `pluginsKeep`. Mirrors the existing `skillsKeep` handling.
- **MCPs**: `~/.claude.json` is no longer symlinked when `mcpsKeep` is provided. Suit reads the real file, filters `mcpServers` to entries in `mcpsKeep`, writes the rewritten copy to `tempHome/.claude.json`. All other top-level keys preserved verbatim. Secrets stay in the rewritten copy on disk under `os.tmpdir()`; cleanup runs on session end.

When neither `pluginsKeep` nor `mcpsKeep` is provided (e.g., a session resolved without a `globals.yaml` in the wardrobe), behavior is identical to v0.6 — full symlink-through. Backwards compatible.

## Consequences

**Positive:**
- Clean separation of concerns: install → user (manual, or any tool of choice). Snapshot → wardrobe (`sync-globals`). Targeting → outfits/modes/accessories. Filter → suit (HOME override).
- Suit's binary doesn't grow a package-manager surface — no install logic, no marketplace API, no version resolution.
- `enable:` / `disable:` is symmetric and composable. Same shape on outfit/mode/accessory; same set-operation semantics; CLI-order layering is intuitive.
- Multi-machine convergence is explicit: each machine syncs, opens a PR, the registry is reconciled deterministically. Pairs naturally with `chezmoi` for the install side.
- Bullet-proof outfits get bullet-proof externals: an outfit can declare "I want the superpowers + obsidian plugins and the axiom + signoz MCPs" and suit will fail-loud (in `metadata.globals.<kind>.unresolved`) if the registry doesn't have them.

**Negative:**
- The registry can drift if `sync-globals` isn't run after installs. Mitigations: run as a SessionStart hook (`recall` precedent); `suit doctor` check; visible drift via `suit current`.
- Schema gain on three primitives is non-trivial reading surface for new authors. Mitigated by both fields being optional with empty defaults — v3 outfits remain valid without modification.
- `~/.claude.json` rewriting means secrets transit through `os.tmpdir()`. Permissions are inherited from the tempdir (default 0700 mkdtemp); the file is removed on session end. Same risk profile as the existing skills filter (which already symlinks through `~/.claude.json` to the tempdir).

**Neutral:**
- No CLI surface change. `--outfit X --mode Y --accessory Z` is the same shape; the new `enable:` / `disable:` are author-side schema, not user-side flags.
- Non-claude-code targets (codex, gemini, copilot, apm, pi) are unaffected by plugin/MCP filtering for v0.7. Their adapters can grow analogous filters in a future ADR if/when those harnesses adopt similar global-tooling models.

## Alternatives considered

1. **Install orchestrator (`suit add plugin <name>`).** Rejected: scope creep. Suit would need to know per-harness install conventions, version resolution, marketplace APIs. The user explicitly wants to keep installs manual.
2. **Allow-list only (`keep: [...]` instead of `enable:` / `disable:`).** Rejected: verbose. To say "frontend doesn't want Linear" the outfit would have to enumerate every other MCP. Symmetric `enable`/`disable` with default-all-on is more ergonomic for the common case.
3. **Per-project `.mcp.json` overrides.** Claude Code does merge a project-level `.mcp.json` over user-level. We could write `.mcp.json` into each project on `suit up`. Rejected: pollutes project repos with files that aren't conceptually part of the project; no clean way to *remove* a user-level MCP via project-level (project-level adds, doesn't subtract). HOME override is cleaner and already in place.
4. **Acquisition + targeting in one model.** Combining install orchestration with filtering would simplify the "I want X" mental model. Rejected: see (1). Suit-as-targeting is enough surface area for now; acquisition can be re-opened in a future ADR if `sync-globals` evolution shows real friction.

## Related

- [ADR-0010](./0010-rename-and-three-tier-composition.md) — the composition primitives this ADR extends.
- [ADR-0013](./0013-accessory-as-role.md) — accessory-as-role; this ADR's `enable:` / `disable:` blocks compose with the accessory-as-role fall-through (an accessory promoted from a singleton skill can also carry an `enable:` / `disable:` block when authored as a real bundle).
- Wardrobe v3 plan (`docs/plans/wardrobe-restructure-v3.md` in wardrobe repo) — the bullet-proof outfit model this ADR makes complete by extending coverage to externals.
- `composeHarnessHome` in `src/lib/ac/symlink-farm.ts` — the HOME-override mechanism Phase A research confirmed and Phase D extends.
