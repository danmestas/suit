# Suit Phase 2 Design

**Date:** 2026-04-30
**Status:** Approved (pending user review of this doc)
**Target version:** v0.2.0

## Goal

Make `suit` usable without manually setting `SUIT_CONTENT_PATH`. Add three new commands (`init`, `sync`, `status`) plus `--help`. Eliminate the `test:ci` exclusion by fixing the underlying coupling. Add regression tests for the two bugs caught during Phase 1's npm-link smoke (extensionless ESM imports in `dist/`, missing `homeDirs()` injection into `runAc()`).

## Scope (single PR)

**Group A — Headline UX:**
- `suit init <url>` — clone content repo
- `suit sync` — pull updates
- `suit status` — show full state (folds in `suit doctor` output)
- `suit --help` / `-h`
- Path migration: `~/.config/agent-config/` → `~/.config/suit/` (with one-version backward-compat read)
- Project-overlay path: `.agent-config/` → `.suit/` (same compat pattern)

**Group B — Hardening:**
- Refactor `validate.ts` to accept content-path as parameter (remove implicit `cwd` dependency)
- Add `TAXONOMY.md` test fixture; drop `test:ci` exclusion (back to a single `npm test` gate)
- Regression test: `dist/` is runnable as standalone Node ESM
- Regression test: `runAc()` honors `SUIT_CONTENT_PATH`

## Out of scope (Phase 3+)

- NodeNext migration / retiring the postbuild import rewriter (ADR-0004 cleanup)
- `relevant-skill.test.ts` skip resolution (delete or relocate)
- Docker harness sweep (`src/tests/integration/docker/**` stale `apm-builder/` refs)
- `agent-config/apm-builder.config.yaml` → `suit.config.yaml` rename; `apm-builder/` removal from agent-config (cross-repo cycle)
- Creating `suit-template` repo (intentionally deferred — `suit init` requires `<url>` arg in v0.2)

## File system layout

| Path | Purpose | Created by | Lifecycle |
|---|---|---|---|
| `~/.local/share/suit/content/` | Cloned content (default tier) | `suit init` | v0.2+ |
| `~/.config/suit/` | User-machine personal overlay | User, manually | v0.2+ |
| `.suit/` (project) | Project-scope overlay | User, in repo | v0.2+ |
| `~/.config/agent-config/` | LEGACY user overlay | n/a | Read-only with deprecation warning in v0.2; removed in v0.3 |
| `.agent-config/` (project) | LEGACY project overlay | n/a | Same: read-only with warning in v0.2; removed in v0.3 |

## Resolution order (highest priority first)

1. Project overlay: `.suit/` (or legacy `.agent-config/`)
2. User overlay: `~/.config/suit/` (or legacy `~/.config/agent-config/`)
3. Default tier: `SUIT_CONTENT_PATH` if set, else `~/.local/share/suit/content/`

This matches the existing 3-tier model in `src/lib/persona.ts` and `src/lib/mode.ts`. The change in v0.2 is the path constants and the new "default tier comes from clone-or-env" rule.

## Commands

### `suit init <url>`

```bash
suit init https://github.com/user/their-config
```

**Behavior:**
- `<url>` is required. Bare `suit init` errors with usage text and a hint that no canonical template repo exists yet (see "Out of scope").
- Resolves target dir to `~/.local/share/suit/content/`.
- If target exists and is non-empty: error. Print:
  ```
  ~/.local/share/suit/content/ already exists. Run `suit sync` to update,
  or `suit init --force <url>` to overwrite.
  ```
- If target does not exist: `git clone <url> <target>` (uses `simple-git` already in deps).
- After clone: scan target for `personas/` or `modes/` directory. Warn (not error) if neither present.
- No harness side effects: does NOT touch `~/.claude/` or any other harness dir. Subsequent `suit claude` will mirror as usual.
- Exit 0 on success; exit 1 on any error.

**Flags:**
- `--force` — `rm -rf <target>` then proceed with clone. Prompts? No — flag is the consent.

### `suit sync`

```bash
suit sync
```

**Behavior:**
- Reads target = `~/.local/share/suit/content/`.
- Errors if target doesn't exist (point user at `suit init`).
- Errors if target is not a git repo (`.git/` missing).
- Errors if working tree dirty: prints `git status` summary and refuses. User stashes/commits manually.
- Errors if HEAD has diverged from upstream: prints "ahead N, behind M" and refuses. User resolves manually with native git.
- Otherwise runs `git pull` against current branch's tracking remote (no `--rebase`, no `--ff-only` flags — let the user's git config decide; default is `--ff-only` in modern git).
- Prints `Already up to date` or `Updated N commits`.

### `suit status` (and bare `suit`)

```bash
suit                # alias for `suit status`
suit status
```

**Output:**

```
suit     v0.2.0
Content: ~/.local/share/suit/content/ (clone of github.com/foo/bar)
Sync:    last 2h ago, ✓ up to date with origin/main
Default: persona=backend mode=focused (from .suit/default.yaml)
Harness: claude ✓  codex ✓  gemini ✓  copilot ✗  apm ✗  pi ✓
```

Variations:
- If `SUIT_CONTENT_PATH` is set: `Content:` line says `(env override → /path)`.
- If content dir absent: `Content: (none — run \`suit init <url>\`)`. Sync line omitted.
- If no `.suit/default.yaml`: `Default: (none configured)`.
- Drift indicator: `✓ up to date` / `⚠ N commits behind origin/main` / `⚠ N commits ahead` / `⚠ diverged (Na/Mb)`.
- Harness presence: same as existing `suit doctor` (still works as a focused alias).

**Source of defaults:** `.suit/default.yaml` in content repo:
```yaml
default:
  persona: backend
  mode: focused
```
Read with existing YAML parser. Missing file → no defaults; defaults section optional.

### `suit --help` / `-h`

Standard Unix-style help text:

```
suit — multi-harness AI agent configurator

USAGE
  suit <harness> [--persona X] [--mode Y] [--no-filter] [-- <harness args>]
  suit init <url> [--force]
  suit sync
  suit status
  suit doctor
  suit list <personas|modes>
  suit show <persona|mode> <name>

ENVIRONMENT
  SUIT_CONTENT_PATH    override the default content directory (overrides clone)

EXAMPLES
  suit init https://github.com/user/their-config
  suit claude --persona backend --mode focused
  suit codex --persona frontend -- --resume sess-123

See https://github.com/danmestas/suit for full docs.
```

`suit <harness> --help` (after a harness name) is passed through to the harness — out of scope to intercept.

## Implementation breakdown

### Files to add

```
src/lib/
├── ac/
│   ├── init.ts            # suit init logic
│   ├── sync.ts            # suit sync logic
│   ├── status.ts          # suit status logic (composes content + harness + defaults)
│   └── help.ts            # --help text generator
├── content-path.ts        # resolve default content dir (env var > XDG clone > undefined)
└── paths.ts               # XDG-style constants: contentDir, userOverlayDir, projectOverlayName

src/tests/
├── ac/
│   ├── init.test.ts
│   ├── sync.test.ts
│   └── status.test.ts
├── content-path.test.ts
├── dist-runnable.test.ts  # regression: dist/ as standalone Node ESM
├── run-ac-env.test.ts     # regression: runAc honors SUIT_CONTENT_PATH
└── fixtures/
    └── TAXONOMY.md        # fixture for validate tests
```

### Files to modify

```
src/ac.ts                  # argv routing: dispatch to init/sync/status/help/etc.
src/lib/validate.ts        # accept contentPath: string parameter (no more implicit cwd)
src/lib/persona.ts         # use new path constants (.suit/ + .agent-config/ fallback)
src/lib/mode.ts            # same
src/tests/validate.test.ts # pass fixture path explicitly
package.json               # remove test:ci script (no longer needed)
.github/workflows/release.yml  # change `npm run test:ci` → `npm test`
```

### Module responsibilities

- **`paths.ts`**: pure constants and a single `resolvePaths()` that returns `{ contentDir, userOverlayDir, projectOverlayName, legacyUserOverlayDir, legacyProjectOverlayName }`. No I/O. No business logic.
- **`content-path.ts`**: `resolveContentDir(env: NodeJS.ProcessEnv): string` — implements the precedence (`SUIT_CONTENT_PATH` > XDG clone path). One pure function. Existing `homeDirs()` in `ac.ts` calls this.
- **`init.ts`**: orchestrates `git clone`. Validates target absence, runs simple-git, scans result. Single exported function: `runInit(args: { url: string, force: boolean }): Promise<number>`.
- **`sync.ts`**: orchestrates `git pull`. Validates state. Single exported function: `runSync(): Promise<number>`.
- **`status.ts`**: composes a status report. Reads content-dir state, harness presence (reuses `doctor` logic), default config (reads `.suit/default.yaml`). Single exported function: `runStatus(): Promise<number>`. Pure formatting; no side effects.
- **`help.ts`**: returns help text as a string. Pure function.

Each file ≤ 150 lines. If any file approaches that, split.

### Path constants (concrete values)

```typescript
// src/lib/paths.ts
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

export const SUIT_PATHS = {
  // Default tier (cloned content)
  contentDir: process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'suit', 'content')
    : path.join(HOME, '.local', 'share', 'suit', 'content'),

  // User overlay (per-machine personal)
  userOverlayDir: process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'suit')
    : path.join(HOME, '.config', 'suit'),

  // Project overlay (per-repo)
  projectOverlayName: '.suit',

  // Legacy paths (read-only with deprecation warning in v0.2; removed in v0.3)
  legacyUserOverlayDir: path.join(HOME, '.config', 'agent-config'),
  legacyProjectOverlayName: '.agent-config',
} as const;
```

XDG support is free (`XDG_DATA_HOME` / `XDG_CONFIG_HOME` env vars override defaults). Most users will never set them; macOS/Linux defaults are sensible.

## Error handling

| Command | Failure mode | Behavior |
|---|---|---|
| `init` | Target exists | Error with `suit sync` / `--force` hint. Exit 1. |
| `init` | Network / auth / 404 | Propagate `git clone` stderr. Exit 1. |
| `init` | git binary missing | Caught error: "git not found on PATH. Install git first." Exit 2. |
| `sync` | Content dir missing | Error: "no content. Run `suit init <url>` first." Exit 1. |
| `sync` | Not a git repo | Error: "<path> is not a git repo. Re-run `suit init`." Exit 1. |
| `sync` | Dirty tree | Print `git status -s` summary + remediation hint. Exit 1. |
| `sync` | Diverged | Print divergence + remediation hint. Exit 1. |
| `status` | Anything missing | Degrade gracefully — never errors. Always exit 0. |
| `--help` | n/a | Print to stdout. Exit 0. |

## Testing strategy

- Each new command gets a focused test file under `src/tests/ac/`.
- `init` and `sync` tests use real `simple-git` against tmpdir fixture repos (no mocks). The repo is created in `beforeEach` with a couple of commits, served via `file://` URL for `init`. This exercises the actual git path.
- `status` tests stub harness binary lookup via the existing `resolveHarnessBin` injection pattern. Content/sync state is built into the tmpdir fixture.
- `validate.ts` refactor: existing 17 tests pass after the parameter threading. The `TAXONOMY.md` fixture lives at `src/tests/fixtures/TAXONOMY.md`.
- `dist-runnable.test.ts`: runs `npm run build` (or relies on it being built), then spawns `node /path/to/dist/ac.js list personas` from a tmpdir with `SUIT_CONTENT_PATH` pointing at a fixture. Verifies exit 0 and non-empty output. This catches regressions in the postbuild import rewriter.
- `run-ac-env.test.ts`: programmatic call to `runAc()` with `SUIT_CONTENT_PATH` set in `process.env`, asserts the resolved content dir is the env-var path. Catches regressions of the bug we fixed in Task 9.

After Phase 2: `npm test` is the single CI gate. No exclusions. The `test:ci` script is removed from `package.json` and the workflow.

## Backward compatibility notes

For one minor version (v0.2.x), suit reads from BOTH the new and legacy paths:

- `SUIT_PATHS.userOverlayDir` (new) and `SUIT_PATHS.legacyUserOverlayDir` (old) are both checked
- If only the legacy path has content, suit reads it AND prints a deprecation warning to stderr the first time per process: `[suit] WARNING: ~/.config/agent-config/ is deprecated. Move to ~/.config/suit/. Legacy path will be removed in v0.3.`
- Same for project-overlay: read both `.suit/` and `.agent-config/` with a single warning.

The warning is printed via `console.warn` (stderr), once per invocation. Removal in v0.3 is tracked in the v0.3 punch list.

## CLI argument parsing

Existing code uses `citty` for `cli.ts` (suit-build). For `suit` (ac.ts), parsing is hand-rolled. Phase 2 keeps it hand-rolled — adding three subcommands is small. If parsing grows past ~50 lines, switch to citty in a follow-up.

Subcommand dispatch in `ac.ts`:
```typescript
const cmd = argv[0];
switch (cmd) {
  case 'init':    return runInit(parseInitArgs(argv.slice(1)));
  case 'sync':    return runSync();
  case 'status':  return runStatus();
  case 'doctor':  return doctorCommand({...});  // existing
  case 'list':    return listCommand({...});    // existing
  case 'show':    return showCommand({...});    // existing
  case '--help':
  case '-h':
  case 'help':    process.stdout.write(helpText()); return 0;
  case undefined: return runStatus();           // bare suit → status
  default:        return runAc(argv, homeDirs()); // existing harness dispatch
}
```

## Observability

None for v0.2. No telemetry, no analytics, no remote logging. CLI output to stdout/stderr is the only signal.

## Acceptance criteria

- `suit init <url>` clones to `~/.local/share/suit/content/` and exits 0
- `suit init <url>` with existing target errors with the documented message
- `suit init --force <url>` overwrites
- `suit sync` runs `git pull` cleanly when state is clean; refuses with clear error otherwise
- `suit status` prints the full layout shown above; degrades gracefully on missing parts
- `suit --help` prints the documented help text
- Bare `suit` prints status
- `npm test` passes with zero failures (no `test:ci` exclusion)
- `dist-runnable.test.ts` passes — regression-protects the postbuild rewriter
- `run-ac-env.test.ts` passes — regression-protects the env-var injection
- Legacy paths still read with deprecation warning (one warning per invocation)
- README updated with new install + quick start (no env-var dance for new users)
- All ADRs amended or new ADRs added where Phase 2 makes new architectural decisions (specifically: ADR-0007 for path migration policy, ADR-0008 if any of init/sync/status surface decisions warrant it)

## Open items deferred

- ADR-0007 (path migration policy) — write during implementation; commit alongside the code change that uses the new constants
- Whether `suit status` should accept `--json` for scripting use — defer to v0.3 if anyone asks
- Whether `suit sync` should accept `--rebase` flag — defer; respect user's git config

---

## Spec self-review

- **Placeholder scan:** none. Every section concrete.
- **Internal consistency:** path tables, command sections, and implementation breakdown all reference the same `SUIT_PATHS.*` constants.
- **Scope check:** Group A + Group B is one PR. No subsystem in here is independent enough to peel off without losing the value of the bundle.
- **Ambiguity check:** `suit init` validates clone has expected layout — explicitly says "warn, don't refuse." `suit sync` divergence behavior — explicitly says "refuse, don't auto-rebase." `suit status` empty content dir — explicitly says "degrade gracefully, exit 0."
