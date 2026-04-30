# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the `suit` project.

ADRs are short-form documents that capture the context, decision, and consequences of significant architectural choices. They exist so future maintainers (and future-Dan) can understand why the codebase looks the way it does without re-deriving every choice from first principles.

## Format

We use the [Michael Nygard ADR template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions). Each record has:

- **Status** — `Accepted`, `Superseded`, `Deprecated`, etc.
- **Context** — the forces at play, the problem being solved.
- **Decision** — what we chose to do.
- **Consequences** — positive, negative, and neutral fallout.
- **Alternatives considered** — what else we looked at and why we rejected it.

Keep ADRs tight (~80-150 lines). They are decision logs, not design documents.

## Index

| # | Title | Status |
|---|---|---|
| [0001](./0001-three-repo-split.md) | Three-repo split: tool, content, template | Accepted |
| [0002](./0002-two-binaries-suit-and-suit-build.md) | Two binaries: `suit` and `suit-build` | Accepted |
| [0003](./0003-content-discovery-via-env-var.md) | Content discovery via `SUIT_CONTENT_PATH` | Accepted |
| [0004](./0004-typescript-esm-with-postbuild-rewriter.md) | TypeScript ESM with postbuild import rewriter | Accepted |
| [0005](./0005-oidc-trusted-publishing.md) | OIDC trusted publishing for npm | Accepted |
| [0006](./0006-package-scope-agent-ops.md) | Package scope: `@agent-ops/suit` | Accepted |
| [0007](./0007-path-migration-policy.md) | Path migration policy (agent-config → suit) | Accepted |
| [0008](./0008-content-store-deep-module.md) | ContentStore as a deep module hiding git | Accepted |

## Adding a new ADR

1. Copy `0001-three-repo-split.md` as a template.
2. Number it sequentially (next free integer, four digits).
3. Title slug should be kebab-case and match the heading.
4. Set the date to today.
5. Set status to `Proposed` while in review, `Accepted` once merged.
6. Add the row to the index table above.
7. Cite related ADRs by number where relevant.

If we ever outgrow this manual process, [adr-tools](https://github.com/npryce/adr-tools) automates the boilerplate. Until then, copy-and-edit is fine.

## Superseding an ADR

When a later decision overrides an earlier one:

1. Set the old ADR's status to `Superseded by ADR-NNNN`.
2. The new ADR should explicitly reference what it supersedes in its Context section.

Do not delete or rewrite history. ADRs are append-only.
