# ADR-0004: TypeScript ESM with postbuild import rewriter

Date: 2026-04-30

## Status

Accepted

## Context

The `suit` codebase is TypeScript, output as ES modules (`"type": "module"` in `package.json`). It runs in two contexts that have different module-resolution rules:

1. **Test runner / dev (`tsx`).** Forgiving. Resolves extensionless imports like `import { foo } from './foo'` happily, with or without a `.ts` source extension on disk.
2. **Node ESM strict mode.** What `npm install -g` produces. Strict. Requires every relative import to have an explicit file extension (`./foo.js`, not `./foo`). Directory imports (`./utils`) must be spelled out as `./utils/index.js`.

The mismatch was caught during the v0.1.0 npm-link smoke test: the package built and tested cleanly under `tsx`, but `npm install -g` followed by invoking the binary blew up with `ERR_MODULE_NOT_FOUND` on the first relative import.

Three ways to reconcile:

1. **Source-level `.js` extensions everywhere.** Standard `NodeNext` pattern. Requires writing `import { foo } from './foo.js'` in `.ts` files, which feels backwards but is the official guidance.
2. **A bundler (esbuild, rollup) that rewrites at build time.** Heavy machinery for what's essentially a string-replace.
3. **A small custom postbuild script** that walks the `tsc` output and adds extensions to relative imports.

We picked (3) for v0.1.x and may revisit in Phase 2.

## Decision

`tsconfig.json` uses `"moduleResolution": "Bundler"`, which lets source code use extensionless relative imports (`from './foo'`). After `tsc` emits to `dist/`, [`scripts/postbuild.mjs`](../../scripts/postbuild.mjs) walks the output and rewrites:

- `./foo` → `./foo.js` if `dist/foo.js` exists.
- `./foo` → `./foo/index.js` if `dist/foo/` is a directory.

Only relative specifiers (`./` or `../`) are touched. Bare specifiers (`fs`, `chokidar`, `@anthropic-ai/sdk`) are left alone.

Build pipeline:

```sh
tsc && node scripts/postbuild.mjs
```

`prepublishOnly` runs `npm run build`, so npm-published artifacts always have the rewriter applied.

## Consequences

**Positive:**
- Source code reads cleanly — no `.js` extensions in `.ts` files. Onboarding cost for new contributors is lower.
- The rewriter is one file (~100 lines). Easy to read, easy to debug, easy to delete.
- No bundler in the dependency tree. Build is `tsc` plus one Node script. Fast.
- Tests under `tsx` run against unmodified source. Production runs against rewritten output. Both work.

**Negative:**
- Two module-resolution mental models in the codebase. A contributor has to know that the rewriter exists or be very confused by why `dist/` looks different from `src/`.
- The rewriter is custom. If it has bugs, we own them. Mitigated by the smoke test catching breakage before publish.
- Edge cases (re-exports, dynamic imports, JSON imports) need to be tested individually. The current rewriter handles static imports and re-exports; dynamic imports would need explicit support if introduced.

**Neutral:**
- This is a bridge solution. Phase 2 may switch to `"moduleResolution": "NodeNext"` plus explicit `.js` extensions in source, which would retire the rewriter. Both choices are reasonable; the rewriter buys us time to defer the decision.
- The build artifact is still standard ESM. Anyone unpacking the tarball sees normal `.js` files with normal imports — no exotic loader, no shim.

## Alternatives considered

- **Source-level `.js` extensions (NodeNext, no rewriter).** The official, idiomatic answer. Rejected for v0.1.x because the team had existing reflexes from the `agent-config` codebase (which used Bundler) and the cost of retraining mid-extraction was higher than the cost of a 100-line script. Strong candidate for Phase 2 once the dust settles.

- **Bundle to a single `dist/index.js` with esbuild/rollup.** Rejected: a CLI doesn't gain meaningfully from bundling. We'd add a build dependency, complicate stack traces, and gain very little. Bundling makes sense for browser code, not Node CLIs.

- **Stay on CommonJS.** Rejected: the broader Node ecosystem is migrating to ESM. Several dependencies we want (and several we already use) are ESM-only. Going CJS would mean fighting the import graph forever.

- **Use `ts-node` or stay on `tsx` in production.** Rejected: requires shipping the TypeScript compiler with the npm package, multiplying install size and startup cost. Also makes `npx @agent-ops/suit` slower than it needs to be.

- **Symlink `index.js` to `index.ts` and patch resolution at runtime.** Rejected: cute but wrong. Makes the binary's behavior depend on filesystem capabilities (symlinks on Windows are a known weak spot).

## Related

- [ADR-0002](./0002-two-binaries-suit-and-suit-build.md) — both bins are products of this build pipeline.
- [ADR-0005](./0005-oidc-trusted-publishing.md) — `prepublishOnly` ensures the rewriter runs before any publish, including OIDC ones.

## Update (2026-04-30, v0.2.2)

Phase 3b retired the postbuild import rewriter. The codebase migrated to `moduleResolution: "NodeNext"` and added explicit `.js` extensions to all relative imports in source. The postbuild script now only handles shebangs and exec bits — the import rewriter is gone.

This was always the cleaner approach; ADR-0004 explicitly noted "Phase 2 may switch to `NodeNext` + explicit `.js` and retire the rewriter." That work happened here.

Status: superseded by NodeNext migration. Retained for historical context.
