# Known test failures (Phase 1 v0.1.0)

The tool was extracted from agent-config without its content (`personas/`, `skills/`, `rules/`, `TAXONOMY.md`, etc.). Tests that depend on workspace content fail in the standalone repo. They will be addressed in Phase 2 by:

- Either: pointing tests at a checked-out fixture clone of `suit-template`
- Or: adding minimal fixtures under `src/tests/fixtures/`

## Failing tests due to missing content (Phase 2 fixture work)

### `src/tests/validate.test.ts`
All three failures share root cause: `validate.ts` reads `TAXONOMY.md` from repo root, which does not exist in the suit repo.

- `persona/mode validation > rejects persona with category not in TAXONOMY` — `ENOENT: TAXONOMY.md`
- `persona/mode validation > rejects persona referencing nonexistent skill in skill_include` — `ENOENT: TAXONOMY.md`
- `persona/mode validation > rejects mode body > 4096 bytes` — `ENOENT: TAXONOMY.md`

### `src/tests/ac-prelaunch.test.ts`
Both tests `spawn('suit-build', ...)`. After Task 9 runs `npm link`, the binary lands on `PATH` and these may still fail because they exercise content paths (codex/copilot prelaunch generates filtered AGENTS.md / copilot-instructions.md from personas+skills). Phase 2 content fixtures will resolve.

- `prelaunchComposeCodex > writes AGENTS.md to a tempdir and returns it as new cwd` — `Error: spawn suit-build ENOENT`
- `prelaunchComposeCopilot > writes copilot-instructions.md to tempdir` — `Error: spawn suit-build ENOENT`

## Failing tests NOT due to missing content

None — the only non-content failure (a Task 3 sed regression in `src/adapters/pi.ts`) was fixed in commit `<see git log for "fix: restore .ts string literals in pi.ts">`.
