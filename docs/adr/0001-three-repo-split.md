# ADR-0001: Three-repo split — tool, content, template

Date: 2026-04-30

## Status

Accepted

## Context

`suit` originated inside the `agent-config` monorepo as the `apm-builder/` subdirectory. That single repo bundled three distinct things:

1. **The tool itself** — TypeScript source for the launcher and build helper.
2. **Dan's team's content** — personas, modes, skills, slash commands. Real working configurations used day-to-day.
3. **A reference example** — implicitly, the only example of what the tool's input format looked like.

These three concerns had different release cadences and different audiences. Every persona tweak required a tool republish if the team wanted the tweak picked up by tooling, and the repo was simultaneously trying to be a working codebase and a public example for outsiders to copy. Fork-ability suffered: a third party who wanted to "try suit" had to clone a repo full of Dan's specific personas, then strip them out.

We needed clean separation between the binary and the content it operates on, plus a clean starter for outsiders.

## Decision

Split into three repositories with distinct roles:

- **[`suit`](https://github.com/danmestas/suit)** — the tool. TypeScript source, npm-published as `@agent-ops/suit`. Versioned with semver. This repo.
- **[`agent-config`](https://github.com/danmestas/agent-config)** — Dan's team's content (personas, modes, skills). The first real-world fork of the template. Updates ship via `git push`; no republish needed.
- **`suit-template`** (planned, Phase 2) — a public, GitHub-flagged template repo. Tiny starter content plus slash commands (`/new-persona`, `/new-mode`, `/new-skill`, `/new-plugin`) that drive AI scaffolding. Third parties click "Use this template" on GitHub and fork it.

The tool reads content from a path the user supplies (see [ADR-0003](./0003-content-discovery-via-env-var.md)). Tool and content are never co-located in the same repo.

## Consequences

**Positive:**
- Tool releases on semver. Content updates as a normal git push. No coupling.
- Third-party adoption path is obvious: fork `suit-template`, run `npm install -g @agent-ops/suit`, point `SUIT_CONTENT_PATH` at the fork.
- The tool repo stays small and focused. Easy to read end-to-end.
- Content repo can move freely (rename, transfer ownership, go private) without breaking the tool.

**Negative:**
- Three repos to maintain. Issues, PRs, and CI live in three places.
- Cross-cutting changes (e.g., adding a new content kind) require coordinated PRs across at least two repos.
- A new contributor has to understand the split before they can mentally model the system.

**Neutral:**
- Documentation has to live somewhere. The tool's README documents the binary's CLI; content-shape conventions live in `suit-template`'s README.
- Releases of the tool are decoupled from any specific content version — pinning is the user's responsibility.

## Alternatives considered

- **Keep everything in `agent-config`.** Rejected: the original setup. Republishing the tool to ship a persona update is wasteful, and the repo can't double as a starter template without confusing newcomers.

- **Tool + template in one repo, content separate.** Rejected: would force `suit-template` to live as a subdirectory of `suit`, blocking GitHub's "Use this template" flag (which operates at repo level, not directory level). Discoverability matters for adoption.

- **Monorepo with workspaces (e.g., pnpm workspaces).** Rejected: solves dependency sharing but does not solve the release-cadence problem. Content still lives next to the tool; "Use this template" still doesn't work at directory granularity.

- **Two repos: tool and content, no separate template.** Rejected as a long-term answer: `agent-config` is opinionated and Dan-specific. A clean starter is necessary for non-Dan users to adopt the tool.

## Related

- [ADR-0002](./0002-two-binaries-suit-and-suit-build.md) — what's actually in the `suit` package.
- [ADR-0003](./0003-content-discovery-via-env-var.md) — how the tool finds the content repo.
- [ADR-0006](./0006-package-scope-agent-ops.md) — npm naming under the new structure.
