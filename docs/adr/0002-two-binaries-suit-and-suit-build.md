# ADR-0002: Two binaries — `suit` and `suit-build`

Date: 2026-04-30

## Status

Accepted

## Context

In the original `agent-config` monorepo there were two CLI entry points:

- `ac` — the runtime launcher. Took a persona/mode and ran the user's harness (Claude Code, Codex, Gemini CLI, GitHub Copilot, APM, Pi) with the right context loaded.
- `apm-builder` — the build helper. Generated filtered `AGENTS.md` and `copilot-instructions.md` files for harnesses (Codex, Copilot) that need a single concatenated instructions file rather than slash-command-style discovery.

The launcher invoked the build helper as a subprocess on prelaunch for those harnesses. The two had distinct responsibilities, distinct flags, and distinct user-facing surfaces, but they lived in the same npm package.

When extracting the tool from the monorepo (see [ADR-0001](./0001-three-repo-split.md)), we had to decide: ship one bin or two? The naming had to change anyway — `ac` was a holdover from `agent-config`, `apm-builder` was a holdover from when the tool was just the build helper.

## Decision

Ship two binaries from the `@agent-ops/suit` package, declared in `package.json` under the `bin` field:

```json
"bin": {
  "suit": "./dist/ac.js",
  "suit-build": "./dist/cli.js"
}
```

- **`suit`** — the runtime launcher. The thing users invoke directly. Renamed from `ac`.
- **`suit-build`** — the build helper. Invoked by `suit` as a subprocess on prelaunch for harnesses that need filtered instruction files. Also runnable directly for users who want to inspect or pre-generate the output. Renamed from `apm-builder`.

Both bins are installed by `npm install -g @agent-ops/suit` and end up on the user's `PATH`.

## Consequences

**Positive:**
- Each binary has a focused man-page-style help output. `suit --help` is short; `suit-build --help` is short. Neither is a sprawling multi-tool dispatcher.
- The subprocess invocation is trivial: `child_process.spawn('suit-build', [...])` with PATH lookup. No need to resolve `__dirname`-relative paths to a sibling JS file.
- Users who only want to inspect built output (`suit-build --dry-run` style flows) don't have to learn launcher flags they don't need.
- Naming is brand-consistent. Both bins start with `suit`, so they sort together in shell completion and `which`.

**Negative:**
- Two PATH entries instead of one. Marginal namespace pollution.
- Slightly larger surface area to document. The README has to explain what each does and when to reach for which.
- A user could in principle invoke `suit-build` standalone in a way that produces inconsistent output relative to what `suit` would have generated. Mitigated by keeping `suit-build`'s flags stable and well-documented.

**Neutral:**
- The two-bin shape mirrors the established Unix pattern (`git` + `git-foo` plumbing). Familiar to anyone who has dug into how `git` extensions work.
- If we ever want one mega-bin, we can add a wrapper later without breaking either name.

## Alternatives considered

- **Single bin with subcommands (`suit run`, `suit build`).** Rejected: the launcher and build helper have very different flag sets. Cramming them under one bin produces an awkwardly-shaped CLI where half the flags are valid for `run` and half for `build`. A clean two-bin split makes the boundary obvious.

- **Keep the original names (`ac`, `apm-builder`).** Rejected: `ac` is undiscoverable (`ac` is "agent-config" only if you already know that), and `apm-builder` overloads "APM" which is just one of six supported harnesses. Renaming was a one-time cost for a permanent legibility win.

- **Single bin, build-helper logic inlined into the launcher.** Rejected: the build helper has its own legitimate standalone use case (CI generation of `AGENTS.md`, manual inspection). Hiding it inside the launcher would force users into ergonomic gymnastics like `suit --build-only --dry-run` to access functionality that wants its own front door.

- **Three bins (split build helper into `suit-build-codex` and `suit-build-copilot`).** Rejected: same generation logic, just different filtering. One bin with a `--harness` flag is correct.

## Related

- [ADR-0001](./0001-three-repo-split.md) — why the tool is its own repo to begin with.
- [ADR-0003](./0003-content-discovery-via-env-var.md) — both bins read content from the same env-var-discovered path.
