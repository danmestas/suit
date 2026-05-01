# ADR-0007: Path migration policy (agent-config → suit)

Date: 2026-04-30
Status: Superseded — legacy support removed in v0.3.0

## Context

Phase 1 inherited path constants from the agent-config monorepo: `~/.config/agent-config/` for the user-machine personal overlay and `.agent-config/` for the per-project overlay. After the rename to `@agent-ops/suit`, these names are misleading.

## Decision

- New paths in v0.2: `~/.config/suit/` (user overlay) and `.suit/` (project overlay).
- Cloned content lives at `~/.local/share/suit/content/` (XDG `XDG_DATA_HOME` honored).
- All path resolution flows through a single function `resolveSuitPaths(env)` in `src/lib/paths.ts`.
- For one minor version (v0.2.x), suit reads from BOTH the new and legacy paths. New paths take precedence when both exist. When only the legacy path has content, suit reads it AND emits a deprecation warning to stderr (one warning per invocation).
- Warnings are returned by `resolveSuitPaths()` as a `string[]` field, not printed via module-scoped state. The top-level `main()` prints them. This avoids hidden-state bugs and makes warnings easy to test.
- v0.3 removes the legacy path read and the warning code.

## Consequences

**Positive:**
- New users have brand-coherent paths (`~/.config/suit/`, `.suit/`).
- Existing users (Dan and team) get a one-version grace period to migrate.
- Path resolution is a pure function — testable, no module state.

**Negative:**
- v0.2 carries dual-path-read code that v0.3 will delete (~10 LOC).
- The grace period is only one minor version, which may be tight if users skip v0.2.

**Neutral:**
- XDG support comes "for free" by reading `XDG_DATA_HOME` / `XDG_CONFIG_HOME` env vars.
- `SUIT_CONTENT_PATH` continues to override the cloned-content directory (Phase 1 contract preserved).

## Alternatives considered

- **Indefinite legacy support.** Rejected — the warning becomes noise, and the legacy code is a maintenance burden.
- **Hard cut at v0.2 (no legacy support).** Rejected — would force every existing user to run `mv ~/.config/agent-config ~/.config/suit` before v0.2 works. Soft migration is cheap.
- **Symlink legacy paths to new ones at startup.** Rejected — surprising filesystem mutation for what should be a read-only resolution.

## See also

- ADR-0003 (content discovery via env var) — `SUIT_CONTENT_PATH` contract is preserved
- ADR-0008 (ContentStore deep module) — uses `paths.contentDir` from `resolveSuitPaths()`

## Update (2026-04-30, v0.3.0)

Phase 3d removed legacy path support per the schedule defined here. `~/.config/agent-config/` and `<projectDir>/.agent-config/` are no longer read; users must migrate to `~/.config/suit/` and `<projectDir>/.suit/`. The deprecation warnings from v0.2.x are gone.

This ADR is superseded by the actual code state. Retained for historical context — explains why v0.2.x had dual-path-read code.
