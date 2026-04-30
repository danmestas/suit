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

## Failing tests NOT due to missing content

None — the Task 3 sed regression in `src/adapters/pi.ts` was fixed earlier, and the two `ac-prelaunch.test.ts` cases that were blocked on `spawn suit-build ENOENT` now pass after Task 9's `npm link` puts `suit-build` on `PATH`.

## Final tally

After Task 9: **3 failures / 269 tests** — all three are the `TAXONOMY.md` ENOENT cases above.
