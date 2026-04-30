# ADR-0005: OIDC trusted publishing for npm

Date: 2026-04-30

## Status

Accepted

## Context

Publishing `@agent-ops/suit` to npm requires authenticated access. The traditional approach is to generate a long-lived npm access token, store it as a GitHub Actions secret (`NPM_TOKEN`), and have the release workflow use it via `npm publish` with the secret in `.npmrc`.

This works, but the operational cost is real:

- **Rotation.** Tokens should rotate periodically. In practice they don't, because rotation requires a human to log into npm, generate a new token, and update the GitHub secret.
- **Storage.** The token sits in GitHub's secret store, in npm's account settings, and (in the worst case) in shell history during initial setup.
- **Leak surface.** Any workflow with read-access to secrets can exfiltrate the token. A single compromised PR check can publish malicious versions of every package the token covers.
- **Scope.** npm tokens default to broad permissions. Scoping to a single package requires extra setup that almost nobody does.

GitHub and npm jointly support OIDC trusted publishing as of 2024. The publishing workflow proves its identity to npm via a short-lived OIDC token issued by GitHub Actions. npm verifies the workflow's repository, workflow file, and (optionally) environment match a publisher configuration registered on the package, and issues a one-shot publish credential.

## Decision

Use OIDC trusted publishing for all `@agent-ops/suit` releases. No `NPM_TOKEN` is stored anywhere.

Configuration:

- **npm side.** Trusted publisher configured at https://npmjs.com/package/@agent-ops/suit/access, naming the GitHub repo (`danmestas/suit`) and the workflow file (`.github/workflows/release.yml`).
- **GitHub side.** Workflow `.github/workflows/release.yml` triggers on `v*.*.*` tag push. The workflow declares `permissions: id-token: write` to request the OIDC token, runs `npm install -g npm@latest` to ensure a sufficiently recent npm CLI, then runs `npm publish --access public --provenance`.
- **Tooling requirement.** OIDC trusted publishing requires npm CLI ≥11.5.1. The workflow upgrades npm in-place before publishing rather than relying on the ambient version.
- **Provenance.** The `--provenance` flag attaches a signed statement linking the published tarball to the GitHub Actions run that produced it. Visible on the package page.

Release flow:

1. Bump version, commit, push.
2. Tag (`git tag v0.1.5 && git push --tags`).
3. Workflow runs, builds, publishes via OIDC.
4. Provenance link appears on npm.

## Consequences

**Positive:**
- No long-lived secret to rotate, store, or leak. Exfiltrating an OIDC token from a malicious PR is meaningless because the token is bound to the workflow run that minted it.
- Provenance comes for free. Anyone installing `@agent-ops/suit` can verify the tarball was produced by `danmestas/suit`'s release workflow on a specific commit.
- Onboarding new packages under `@agent-ops` is trivial: add a trusted publisher config on npm, copy the workflow file. No secret to mint.
- Aligns with industry direction. PyPI, RubyGems, and others have converged on OIDC trusted publishing. Familiarity will compound.

**Negative:**
- Local publish (`npm publish` from a developer machine) still works but is now the second-class path. Any mismatch between local-published artifacts and OIDC-published artifacts (different `npm` version, different OS) is a real risk.
- Requires npm CLI ≥11.5.1. The workflow handles this with `npm install -g npm@latest`, but local maintainers also need to upgrade.
- Tied to GitHub. If we ever migrate hosting, we need to reconfigure the trusted publisher. Mitigated by trusted publishing being supported on GitLab as well; the migration would be configuration, not architecture.
- Debugging publish failures requires understanding both GitHub Actions OIDC and npm's verification path. The error messages improve every release but are not yet as good as token-based ones.

**Neutral:**
- The workflow file is documented as the source of truth for "how do we ship a release." Changes to it are visible in PR review.
- Rotation is not just easier — it doesn't apply. There is nothing to rotate.

## Alternatives considered

- **Stored `NPM_TOKEN` secret.** The status quo across most npm packages. Rejected: rotation friction, leak surface, and broad-scope tokens. OIDC eliminates all three.

- **Granular automation token, scoped to one package.** Improvement over a broad token. Still rejected: still a long-lived credential, still has to be rotated, still gains nothing over OIDC except marginal compatibility with older npm versions we don't need to support.

- **Manual publish from a maintainer's laptop.** Rejected: bus factor of one, no provenance, no audit trail, no CI gate between "PR merged" and "tarball public." Tag-driven CI publish is the safe path.

- **Wait for OIDC support to stabilize further.** Rejected: it's stable enough. PyPI shipped trusted publishing in 2023, npm in 2024, and the feature surface is now well-trodden. Adopting now means we never store a token.

## Related

- [ADR-0004](./0004-typescript-esm-with-postbuild-rewriter.md) — the build pipeline that runs inside the publish workflow.
- [ADR-0006](./0006-package-scope-agent-ops.md) — the `@agent-ops` scope that the trusted publisher is configured against.
