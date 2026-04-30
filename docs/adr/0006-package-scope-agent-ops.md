# ADR-0006: Package scope `@agent-ops/suit`

Date: 2026-04-30

## Status

Accepted

## Context

When extracting `suit` from the `agent-config` monorepo (see [ADR-0001](./0001-three-repo-split.md)) we needed an npm package name. Three properties mattered:

1. **Available.** The name had to be claimable on npmjs.com without contacting registry support.
2. **Brand-aligned.** The name should reflect the project, not the maintainer's identity. The project may grow into a multi-maintainer thing.
3. **Future-proof.** Room for related packages to live alongside (`@agent-ops/something-else`) without scope thrash.

Three names were tried, in order:

### Attempt 1: `@suit`

The cleanest possible name. Rejected by npm — when an unscoped package exists (in this case `suit`, owned by another author), npm reserves the matching scope `@suit` as typo-squatting protection. Asking npm to release the scope requires the existing `suit` package owner to consent or for the scope to be unused for an extended period. Not worth fighting.

### Attempt 2: `@danmestas/suit`

Personal scopes are auto-claimed when you sign up — `@<your-username>` is yours. This worked immediately and would have been a fine answer. Tied the package's namespace to a single human, which is reversible (we could republish under a new scope later) but adds a migration step for users.

### Attempt 3: `@agent-ops/suit`

Created a new free org `@agent-ops` on npmjs.com. Free orgs allow public packages and have no per-publisher cost. The scope reads as a brand ("agent ops") rather than a person.

## Decision

Publish as `@agent-ops/suit`.

- Scope: `@agent-ops`, a free org on npmjs.com.
- Package: `@agent-ops/suit`.
- Trusted publisher (see [ADR-0005](./0005-oidc-trusted-publishing.md)) configured against this exact scope/package pair.

Future tools in the same family can publish under the same scope: `@agent-ops/some-future-tool`. Multi-maintainer ownership is supported by npm orgs out of the box; we'd just add maintainers to the `@agent-ops` org.

## Consequences

**Positive:**
- Brand is decoupled from any single maintainer. If Dan steps back, the org stays.
- Future packages under `@agent-ops` get namespace-level trust by association. Easier for users to evaluate "is this from the same group as `@agent-ops/suit`?"
- Free org tier covers everything we need (public packages, multiple maintainers). No billing surface to manage.
- Searchable. `npm search @agent-ops` lists everything in the family.

**Negative:**
- Scoped names are slightly longer to type. `npm install -g @agent-ops/suit` versus `npm install -g suit`. Marginal.
- Anyone who tab-completes `suit` on npm sees the unscoped package (owned by another author) rather than ours. README and docs have to be explicit about the full scoped name.
- The `@suit` typo-squatting reservation means even if the unscoped package ever changes hands, we still couldn't trivially claim `@suit` — npm reservations don't auto-release.

**Neutral:**
- Org membership is a separate concern. Today only Dan is a member; adding maintainers later is one click in npm's UI.
- The choice is reversible at minor cost: republish under a new scope and deprecate the old name. Done it before, can do it again.

## Alternatives considered

- **`@suit/suit`.** Blocked by npm typo-squatting reservation. See Context.

- **`@danmestas/suit`.** Worked but ties the brand to one human. Rejected as a long-term answer; would require migration the first time we wanted multi-maintainer ownership without a scope rename.

- **Unscoped name (`suitkit`, `suit-cli`, `agent-suit`).** Considered. Rejected because every halfway-reasonable name was either taken or close to a typo of an existing package. Scoped names sidestep the squat-the-good-names problem entirely.

- **`@agentops/suit` (no hyphen).** Already taken by an unrelated company (https://agentops.ai/). The hyphenated `@agent-ops` is distinct enough to avoid confusion while remaining readable.

- **Skip npm, distribute via GitHub releases or Homebrew.** Rejected: npm is where this audience lives. AI tooling users are Node-adjacent enough that `npm install -g` is the path of least friction.

## Related

- [ADR-0001](./0001-three-repo-split.md) — repo structure that necessitated picking a package name.
- [ADR-0005](./0005-oidc-trusted-publishing.md) — trusted publisher is configured against `@agent-ops/suit` specifically.
