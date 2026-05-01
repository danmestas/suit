# ADR-0009: Explicit path dependencies and shared harness presence

Date: 2026-04-30
Status: Accepted

## Context

Phase 2 added three commands (`init`, `sync`, `status`) and refactored existing code touched by the path migration (ADR-0007) and the introduction of `ContentStore` (ADR-0008). Two smaller architectural decisions surfaced during the Ousterhout review of the spec that are not covered by 0007 or 0008:

1. `src/lib/validate.ts` previously resolved its content path via implicit `process.cwd()`. The rest of the codebase passes a `Dirs` (or `DiscoveryDirs`) object through every layer. The mismatch made `validate` the only module with a hidden environmental dependency.
2. The existing `suit doctor` command and the new `suit status` command both report which harness binaries are installed. Two independent implementations would drift over time, producing subtly different reports for the same machine.

## Decision

- **`validate.ts` accepts `Dirs` (or `DiscoveryDirs`) as a parameter rather than reading `process.cwd()`.** All call sites construct the object once at the top of `main()` and thread it down. Tests pass a fixture path explicitly.
- **Extract `getHarnessPresence(harnesses): Promise<HarnessPresence[]>` into `src/lib/ac/harness-presence.ts`.** Both `status` and `doctor` consume it. Each command formats the result for its own output, but the underlying detection (which binaries exist on `$PATH`, at which paths) is single-sourced.

## Consequences

**Positive:**
- `validate` is now testable without fighting `process.cwd()` — tests pass a tmpdir Dirs object.
- Harness presence cannot drift between `status` and `doctor`. Adding a new harness is a one-line change in the catalog, picked up by both commands.
- Path-resolution policy lives in one place (`resolveSuitPaths` from ADR-0007); every consumer of paths is explicit about what it needs.

**Negative:**
- One additional file (`harness-presence.ts`) and one additional argument on `validate` functions. Trivial cost.

**Neutral:**
- The `Dirs` shape was already used elsewhere in the codebase. This change brings `validate` into line, not introducing a new abstraction.

## Alternatives considered

- **Leave `validate.ts` reading `process.cwd()`.** Rejected — implicit dependencies (Ousterhout) make tests fragile and behavior surprising when callers operate on a path other than the current directory.
- **Duplicate the harness-presence loop in `status.ts` and `doctor`'s implementation.** Rejected — conjoined methods that drift are a documented anti-pattern; the duplication offers no benefit since the formatting differences live in the consumers anyway.
- **Have `status` shell out to `doctor` and parse its output.** Rejected — coupling two CLI commands through their stdout is brittle. A shared internal function is simpler and cheaper to test.

## See also

- ADR-0007 (path migration policy) — `Dirs` is built from `resolveSuitPaths().paths`
- ADR-0008 (ContentStore deep module) — `status` composes `ContentStore.status()` with `getHarnessPresence()` results
