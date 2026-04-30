# ADR-0003: Content discovery via `SUIT_CONTENT_PATH`

Date: 2026-04-30

## Status

Accepted

## Context

After the three-repo split (see [ADR-0001](./0001-three-repo-split.md)), the tool no longer ships its own content. Personas, modes, skills, and plugin definitions live in a separate repo that the user maintains. The tool needs to find that repo at runtime.

This is essentially the same problem as: how does `git` know where your dotfiles are? How does `direnv` know where your `.envrc` lives? Conventions vary — some tools hardcode `~/.config/<name>`, some require a flag, some sniff the current directory upward, some rely on env vars.

For v0.1.x we wanted the simplest mechanism that:

1. Works on day one with zero scaffolding (no setup wizard required).
2. Lets a user point at any path on disk — they might keep content in `~/projects/agent-config`, or `~/work/team-personas`, or anywhere else.
3. Doesn't lock us into a path scheme we'd regret in Phase 2.
4. Is greppable, explainable, and trivial to override per-shell or per-project.

We also have a clear Phase 2 plan: `suit init [<repo-url>]` will clone content to a default location (`~/.local/share/agent-config/`), defaulting to the public `suit-template`. That's discovery layered on top of pointing-at-a-path, not a replacement.

## Decision

For v0.1.x, content path is supplied via the `SUIT_CONTENT_PATH` environment variable.

```sh
export SUIT_CONTENT_PATH=~/projects/agent-config
suit run my-persona
```

If the variable is unset or points to a non-existent directory, `suit` exits with a clear error message that names the variable and links to the docs.

Phase 2 will add `suit init [<repo-url>]`, which clones content to `~/.local/share/agent-config/` (default = the public `suit-template` repo). After init, the env var is still respected as an override; users who already set it keep their existing setup. Init populates a default location so users who want zero-config can get there.

## Consequences

**Positive:**
- One env var. No config file format to design, parse, or migrate. No directory-walking magic.
- Users who already have content in a non-default location (Dan, the day-zero user) just `export SUIT_CONTENT_PATH=...` and it works.
- Per-project overrides are trivial: `direnv`, shell scripts, or a `.envrc` per workspace. No tool-side support needed.
- Errors are obvious: missing var → named error message → fix is one line in the user's shell config.
- Easy to test: tests set the var to a fixture directory and run the binary.

**Negative:**
- Discoverability is poor for new users. They install `suit`, run it, and get an error. The error has to be very good. Phase 2's `suit init` is the real fix.
- Forgetting to export the var leaks no-content into wherever the binary is invoked. Mitigated by failing fast and loudly.
- No way for the tool to know which content version was tested against which tool version. Pinning is the user's responsibility.

**Neutral:**
- Standard Unix env-var pattern. Familiar to anyone who has used `EDITOR`, `PAGER`, `XDG_*`, etc.
- Convention is reversible. We can layer config-file or auto-discovery support later without breaking the env-var path.

## Alternatives considered

- **Hardcoded path (`~/.config/suit/content` or `~/.local/share/agent-config`).** Rejected for v0.1.x: would force every existing user to either move their content or symlink. Phase 2 introduces a default *with* the env-var override still working, so this becomes a layered solution rather than a forced migration.

- **CLI flag (`suit --content-path=...`).** Rejected as the *only* mechanism: users would have to repeat the flag on every invocation. Considered as an addition; deferred until there's real demand. Env var covers the use case.

- **Config file (`~/.suitrc`, `suit.config.json`).** Rejected for v0.1.x: introduces a file format, parser, and validation surface for a single field. YAGNI. If we ever need more than one field we can revisit.

- **Walk-up discovery (find nearest `agent-config/` ancestor of `cwd`).** Rejected: implicit, brittle, and surprising. Users would not know which content directory was in scope from a given working directory without running a "where am I" subcommand.

- **Global flag plus env var fallback.** Rejected for v0.1.x: more code paths to test and document. Env-var-only is simpler. CLI flag can be added in Phase 2 if needed.

## Related

- [ADR-0001](./0001-three-repo-split.md) — why the tool doesn't ship its own content.
- [ADR-0002](./0002-two-binaries-suit-and-suit-build.md) — both bins read from the same env-var-discovered path.
