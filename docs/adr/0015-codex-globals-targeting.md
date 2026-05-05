# ADR-0015: Codex globals targeting

Date: 2026-05-05
Status: Accepted

## Context

ADR-0014 introduced `globals.yaml` plus `enable:` / `disable:` blocks for outfits, modes, and accessories — but only against the claude-code harness. The HOME-override mechanism that backs the filter (rewriting `installed_plugins.json` and `~/.claude.json`'s `mcpServers`) is claude-code-specific. Other harnesses with similar global-tooling models — first among them, Codex — were left without an equivalent.

Codex on this machine ships a real, growing surface that maps cleanly onto the same filter abstraction:

- `~/.codex/config.toml` carries `[plugins."<bare>@<marketplace>"]` blocks with an `enabled` boolean (currently 9 plugins). Disabled plugins simply aren't loaded.
- The same file carries `[mcp_servers.<id>]` blocks (stdio and http transports — `command`/`args`/`env_vars` for stdio, `url`/`http_headers`/`bearer_token_env_var` for http).
- `[marketplaces.<name>]` blocks register marketplaces (registry of where plugins COME from — not plugins themselves).
- `~/.codex/skills/` exists with the same per-skill SKILL.md layout claude-code uses.
- `~/.codex/hooks/` exists (out of scope for v0.8 globals filtering — no hook entries are tracked in the registry yet).
- `$CODEX_HOME` overrides `~/.codex` location. Codex does NOT honor `HOME` for config discovery — it looks at `CODEX_HOME` exclusively.

This means the v0.7 `composeHarnessHome` mechanism (which sets `HOME=<tempdir>`) cannot reach codex. We need a parallel composition path that produces a `CODEX_HOME` tempdir.

## Decision

**Extend the v0.7 design horizontally, not redesign it.** The registry, the resolver semantics, and the prelaunch/cleanup contract all keep their shapes. Three localized extensions cover codex:

### 1. Optional `harness` discriminator on registry entries

`GlobalsPluginEntry` and `GlobalsMcpEntry` gain an optional `harness: 'claude-code' | 'codex'` field. The hook entry shape gains the same field but isn't actively used in v0.8.

- Omitted ≡ `'claude-code'` for backwards compatibility — every v0.7 registry parses and behaves identically.
- Codex sync writes `harness: 'codex'` explicitly on every entry it produces.
- Cross-harness bare-name collisions (e.g. `signoz` exists on both) follow ADR-0014's marketplace-disambiguation pattern: claude-code wins the bare slot, codex moves to `<name>-codex`. Outfit authors can reference either form.

### 2. `sync-globals` reads codex config.toml

`buildGlobalsSnapshot` gains a codex walker that:

- Parses `<CODEX_HOME>/config.toml` with `@iarna/toml` (already a suit dependency).
- Walks `[plugins."<bare>@<marketplace>"]` blocks, splitting on the last `@` to recover bare-name + marketplace. Marketplaces with the same bare name across multiple plugins get the disambiguated `<bare>-<marketplace>` registry key (mirrors claude-code's collision handling).
- Walks `[mcp_servers.<id>]` blocks, classifying as http (top-level `url`) or stdio (top-level `command`). Records non-secret metadata only — `has_env` (presence flag from `env_vars` or `env`), `has_headers` (presence flag from `http_headers` or `bearer_token_env_var`).
- Merges into the unified registry via a deterministic per-kind merge that grants the bare slot to claude-code on collision.

### 3. `composeCodexHome` — config.toml rewrite, parallel to `composeHarnessHome`

A new module `src/lib/ac/codex-home.ts` exports `composeCodexHome(opts)`. Its mechanism:

1. `mkdtemp` an `ac-codex-home-*` tempdir.
2. Symlink every entry of `<realCodexHome>` into the tempdir EXCEPT `skills/` (rebuilt below) and `config.toml` (rewritten when filter is requested).
3. When `pluginsKeep` is provided: parse the real `config.toml`, set `enabled = false` on every `[plugins."<bare>@<marketplace>"]` block whose bare name (or `<bare>-<marketplace>` disambiguated form) is NOT in the kept set. Kept entries are LEFT ALONE — we don't force `enabled = true` on a plugin the user disabled out of band.
4. Same treatment for `mcpsKeep` against `[mcp_servers.<id>]` blocks: `enabled = false` on non-kept ids; kept entries unchanged.
5. Stringify the mutated TOML back via `@iarna/toml` and write it as a real file in the tempdir.
6. Build a curated `skills/` subdir using the same `skillsKeep` mechanism as claude-code.

The codex `config.toml` rewrite is the structural analog of claude-code's combined `installed_plugins.json` + `~/.claude.json` rewrite. Fewer files to handle (one TOML vs one JSON manifest + one JSON config) — but the same surface contract.

### 4. Resolver gains harness-scoped filtering

`resolve()` consults the active `harness` when applying enable/disable layers over the globals registry:

- `harness === 'claude-code'`: only entries with `entryHarness(e) === 'claude-code'` (omitted treated as claude-code) participate in baseline + kept/dropped sets.
- `harness === 'codex'`: only entries with `entryHarness(e) === 'codex'`.
- Other harnesses (`gemini`, `copilot`, `apm`, `pi`): all-empty kept/dropped sets — there is no harness-side filter for them today.

A cross-harness `enable:` reference (e.g. an outfit `enable.plugins: ['codex-only']` evaluated in a claude-code session) is silently skipped — neither warned nor recorded as `unresolved`. This lets a single outfit carry both harnesses' enable lists without spamming warnings on every launch. A reference to a name not present in the registry at all is still warned and tracked, exactly as in v0.7.

### 5. Prelaunch + session wire `CODEX_HOME`

`prelaunchComposeCodex` gains an optional `codexHomeFilter` parameter; when present, it calls `composeCodexHome` and returns both the project-cwd tempdir (for `AGENTS.md`) and the codex-home tempdir. Both cleanups are chained in the returned `cleanup` function.

`session.ts` invokes `composeCodexHome` only when:
- The session is filtered (outfit/mode/accessory present), AND
- A globals registry was successfully loaded.

When both apply, `CODEX_HOME=<tempdir>` is set in the spawn env. The pre-existing `cwd=<project-tempdir>` and `AC_ORIGINAL_CWD` plumbing is unchanged. Codex does not consume `HOME`, so `HOME` is intentionally untouched in the codex spawn env.

## Consequences

**Positive:**

- Symmetric coverage: a single outfit can declare `disable.plugins: [signoz]` and have both the claude-code and codex composed environments turn signoz off, even though the underlying mechanism differs (manifest rewrite vs `enabled = false`).
- The harness discriminator is the right axis: it makes cross-harness collisions explicit (no surprise wildcard matching), keeps each harness's filter implementation isolated, and lets future harnesses join via the same pattern (add a literal to `GlobalsHarnessEnum`, add a `composeXHome`, add a session.ts case).
- Codex's `enabled` flag IS the canonical disable mechanism — we're not inventing a side-channel. Codex itself respects it; rewriting it is the cleanest possible filter.
- Skills filtering for codex falls out for free — same `skillsKeep` handling, same `SKILL.md` manifest layout.
- v0.7 registries continue to parse and resolve identically. Existing 499 tests stay green.

**Negative:**

- Two separate composition paths (`composeHarnessHome` for claude-code/gemini/pi; `composeCodexHome` for codex) carry duplicated symlink-mirroring boilerplate. We accepted this rather than over-abstract a base helper before a third harness needs the pattern.
- Cross-harness `enable:` references being silent could mask a typo (user meant `cc-plugin`, wrote `codex-plugin`, ran a claude-code session — no warning). Tradeoff for a more pleasant authorial experience; we can revisit when v0.9 brings cross-harness outfits into routine use.
- Codex's TOML format is sensitive to round-tripping. `@iarna/toml` re-serializes deterministically but doesn't preserve comments or original whitespace. The rewritten `config.toml` differs cosmetically from the original — visible only in the tempdir, never written back to `~/.codex`.

**Neutral:**

- `CODEX_HOME` lives in `os.tmpdir()` for the session lifetime. Same risk profile as the claude-code tempdir: per-user permissions, removed on session end.
- Other harnesses (`gemini`, `copilot`, `apm`, `pi`) keep empty kept/dropped sets — this is a no-op semantic regression at most, and only for sessions that explicitly resolved a filter on these harnesses while a globals registry was loaded.

## Alternatives considered

1. **Fork the registry — separate `globals-claude-code.yaml` and `globals-codex.yaml`.** Rejected: doubles the sync surface, fragments the bullet-proof-outfit story, and requires the resolver to load and union two files. The single-file + harness discriminator is strictly simpler and lets cross-harness merges be deterministic.
2. **Reuse `composeHarnessHome` with a target-specific dispatch.** Rejected: the file format (TOML vs JSON), the env var (`CODEX_HOME` vs `HOME`), and the on-disk shape (single-file canonical config vs split manifest + config) diverged enough that the abstraction cost (more conditionals than shared logic) outstripped the duplication cost. We can revisit if a third harness brings these closer.
3. **Mutate `~/.codex/config.toml` in place and revert on session end.** Rejected: blast radius across concurrent sessions, requires careful crash-recovery (what if the user kills the harness ungracefully?), and trips on `chezmoi`-style dotfile management. The tempdir-with-CODEX_HOME-override pattern is exactly how claude-code does it and exactly what codex's `CODEX_HOME` env var was designed for.
4. **Treat codex `enabled = false` as the registry-side ground truth (sync respects user disables).** Considered briefly. Rejected for v0.8: the registry's job is to record what EXISTS, not what's currently enabled. Suit's filter mechanism is what enforces the enabled set per-session. Mixing user-state into the registry would couple the wardrobe-side tooling to per-machine session state and break the "registry as installed-tooling source-of-truth" contract.

## Related

- [ADR-0014](./0014-globals-targeting.md) — the v0.7 ADR this extends. The mechanism, semantics, and authorial guidance carry over verbatim; v0.8 is purely additive.
- `src/lib/ac/symlink-farm.ts` — the claude-code `composeHarnessHome` this v0.8 work parallels.
- `src/lib/ac/codex-home.ts` — the v0.8 codex composition path added by this ADR.
- `src/lib/sync-globals.ts` — extended with the codex walker.
- `src/lib/resolution.ts` — `resolveGlobalsKind` gained the `harnessFilter` argument.
