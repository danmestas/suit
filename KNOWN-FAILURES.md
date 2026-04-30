# Known test failures (Phase 1 v0.1.0)

The tool was extracted from agent-config without its content (`personas/`, `skills/`, `rules/`, `TAXONOMY.md`, etc.). Tests that depend on workspace content fail in the standalone repo. They will be addressed in Phase 2 by:

- Either: pointing tests at a checked-out fixture clone of `suit-template`
- Or: adding minimal fixtures under `src/tests/fixtures/`

## Summary (commit 8827df3)

```
 Test Files  3 failed | 53 passed | 1 skipped (57)
      Tests  7 failed | 260 passed | 2 skipped (269)
```

## Failing tests due to missing content (Phase 2 fixture work)

### `src/tests/validate.test.ts`
All three failures share root cause: `validate.ts` reads `TAXONOMY.md` from repo root, which does not exist in the suit repo.

- `persona/mode validation > rejects persona with category not in TAXONOMY` — `ENOENT: TAXONOMY.md`
- `persona/mode validation > rejects persona referencing nonexistent skill in skill_include` — `ENOENT: TAXONOMY.md`
- `persona/mode validation > rejects mode body > 4096 bytes` — `ENOENT: TAXONOMY.md`

## Failing tests NOT due to missing content (investigate before v0.1.0)

### `src/tests/ac-prelaunch.test.ts`
Both failures share root cause: tests `spawn('suit-build', ...)` which is not on `PATH` until `npm link` runs (Task 9). After Task 9, these are expected to pass against the local content layout. They will still fail under standalone-suit semantics until Phase 2 content fixtures land, but that's a content failure layered on top of the link failure.

- `prelaunchComposeCodex > writes AGENTS.md to a tempdir and returns it as new cwd` — `Error: spawn suit-build ENOENT`
- `prelaunchComposeCopilot > writes copilot-instructions.md to tempdir` — `Error: spawn suit-build ENOENT`

### `src/tests/adapters/pi.test.ts` — regression from commit `1d4a50f`
Two failures share root cause: commit `1d4a50f` ("chore: add tsconfig and vitest config") performed a bulk rewrite that stripped `.ts` extensions from imports and incorrectly rewrote two unrelated string literals in `src/adapters/pi.ts`:

- L107: `main: 'src/index.ts'` → `main: 'src/index'` (in `emitPluginPackage`)
- L266: `main: 'index.ts'` → `main: 'index'` (in `emitHookExtension`)

These are package.json `main` field values for the emitted Pi-package output, not TypeScript imports. They should not have been rewritten. Tests:

- `pi adapter > emits a Pi-package directory for plugin components` — `expected 'src/index' to be 'src/index.ts'`
- `pi adapter > emits a TS extension scaffold for hook components` — golden diff: `content mismatch: .pi/extensions/tts-announcer/package.json`

Recommended fix before v0.1.0: revert the two literals in `src/adapters/pi.ts`. The fix is one-line per literal and is verifiable by re-running `npm test` (both pi tests pass when reverted). Tracked here, not auto-fixed in Task 8 per plan's "capture, don't fix" constraint for non-build regressions.
