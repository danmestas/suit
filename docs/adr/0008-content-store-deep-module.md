# ADR-0008: ContentStore as a deep module hiding git

Date: 2026-04-30
Status: Accepted

## Context

Phase 2 adds three commands (`init`, `sync`, `status`) that all touch the cloned content directory at `~/.local/share/suit/content/`. Each needs to:

- Detect whether the directory exists
- Detect whether it is a git repo
- Read the `origin` remote URL
- For `init`: clone a URL, optionally with `--force` overwrite
- For `sync`: detect dirty trees, run `git pull`, count updated commits
- For `status`: report sync state (ahead/behind/up-to-date)

A naive implementation would call `simple-git` directly from each command file. That spreads git knowledge across three files and creates change-amplification: any improvement to error formatting or state detection has to be made in three places.

## Decision

Introduce a deep module `src/lib/content-store.ts` exposing a small interface:

```typescript
interface ContentStore {
  status(): Promise<StoreStatus>;
  init(url: string, force: boolean): Promise<InitResult>;
  sync(): Promise<SyncResult>;
}

function openContentStore(targetPath: string): ContentStore;
```

All `simple-git` calls, target-existence checks, dirty-tree detection, and divergence detection live inside this module. The three command files (`src/lib/ac/init.ts`, `sync.ts`, `status.ts`) are thin formatters that consume this interface.

`init` and `sync` both return `Result`-shaped objects (`{ ok, message }`). This consistency means commands consume them with a uniform pattern (no try/catch), which keeps the formatter files small.

## Consequences

**Positive:**
- Change amplification eliminated: improving git semantics happens in one file.
- Each command file is small (~30 LOC) and trivially testable.
- The git library can be swapped without touching command files.
- Tests can target the store directly with real `simple-git` against tmpdir fixture repos — no mocks.

**Negative:**
- One additional file to navigate (mitigated by the small surface).
- The store interface needs to be designed up-front; adding new operations requires interface changes.

**Neutral:**
- `simple-git` was already in dependencies for `release/git.ts`. No new dependencies.

## Alternatives considered

- **Direct simple-git calls in each command.** Rejected — change amplification across three files.
- **One `git-helpers.ts` utility module of free functions.** Rejected — same problem in different shape: the store's stateful operations (init/sync) want to live behind a single interface, not as scattered functions sharing a target path.
- **Reuse the existing git logic in `release/git.ts`.** Rejected — that module is built around release-tagging concerns, not content-repo lifecycle. Different domain.
- **Throw on init "already exists", return Result on sync.** Rejected during code review — asymmetric error-handling forces consumers into mixed try/catch + Result patterns. Result everywhere is cleaner.

## See also

- ADR-0001 (three-repo split) — content-store operates on the agent-config repo (or fork) cloned to `~/.local/share/suit/content/`
- ADR-0007 (path migration) — store is opened at the path returned by `resolveSuitPaths().paths.contentDir`
