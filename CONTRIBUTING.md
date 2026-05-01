# Contributing to suit

Thanks for taking a look. suit is a small, focused tool — contributions land best when they fit the existing architecture, are tested, and ship with thought to the broader ecosystem (`suit-template` content repos, downstream forks, npm consumers).

## Setup

```bash
git clone https://github.com/danmestas/suit
cd suit
npm install
npm run build         # tsc + postbuild
npm link              # exposes `suit` and `suit-build` globally
npm test              # vitest
```

`npm link` is required for the `codex` and `copilot` subcommands to work end-to-end (they shell out to `suit-build`). Without it, those subcommands error with `ENOENT: spawn suit-build`.

## Development workflow

- Branch from `main`, name `feat/...` or `fix/...` or `docs/...`.
- TDD where the spec is clear: write the failing test, then the code.
- Keep commits small and focused; prefer many small commits over one big one.
- Run `npm test`, `npm run typecheck`, and `npm run build` before opening a PR.
- Never push to `main` directly. Open a PR for review and merge.
- Don't skip pre-commit hooks (`--no-verify`) without a documented reason.

## Architecture

Read the ADRs in `docs/adr/` before proposing structural changes. They document the why behind decisions like:

- Three-repo split (tool / template / content)
- Two binaries (`suit` + `suit-build`)
- Content discovery via `SUIT_CONTENT_PATH` and `suit init`
- OIDC trusted publishing
- ContentStore as a deep module hiding git

If you're proposing something an ADR contradicts, the right move is to write a new ADR superseding it, not to ignore it.

## Testing

- Unit tests use `vitest`. Keep them small and behavioral, not implementation-coupled.
- Integration tests use real `simple-git` against tmpdir fixture repos — no mocks.
- Regression tests guard against the two bugs caught in Phase 1: extensionless ESM imports in `dist/`, and `runAc()` ignoring `SUIT_CONTENT_PATH`. Don't break either.

## Releases

`npm version <patch|minor|major>` followed by `git push --follow-tags` triggers `.github/workflows/release.yml`, which publishes via OIDC and creates a GitHub Release. No stored npm token; no manual step.

## Forking

If you want your own version of suit (different default template, different brand), fork the repo and update `package.json`'s `suit.templateUrl` field to point at your template repo. The rest of the tool is reusable.

## Reporting bugs

Open an issue on GitHub. Include: suit version (`suit status` shows it), the harness you're using, and the exact command + output.
