/**
 * `suit current` — read-only inspection of the project's `.suit/lock.json`.
 *
 * Reports the active resolution, count of tracked files, a few sample paths,
 * and per-file drift detection (current sha256 vs the lockfile's recorded
 * sha256). Drift is informational — exit code stays 0 even when present, so
 * `suit current` can be used in scripts without a guard. ADR-0012 §"Lockfile
 * shape" defines the on-disk schema; this command is the inverse of `suit up`.
 *
 * Phase B (this file) ships before `suit off`. The drift report is the
 * forensic surface a user sees when they hand-edit a tracked file: by the
 * time `suit off` (Phase C) lands, the same drift values gate refuse-when-
 * dirty there too.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { LOCKFILE_PATH, readLockfile, sha256OfFile } from '../lockfile.js';

export interface RunCurrentArgs {
  projectDir: string;
}

export interface RunCurrentDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const SAMPLE_LIMIT = 5;

export async function runCurrent(args: RunCurrentArgs, deps: RunCurrentDeps): Promise<number> {
  const lock = await readLockfile(args.projectDir);
  if (!lock) {
    deps.stdout('(no suit applied — run `suit up --outfit X` to dress this project)\n');
    return 0;
  }

  // Resolution + apply timestamp.
  const r = lock.resolution;
  deps.stdout(`outfit:       ${r.outfit ?? '(none)'}\n`);
  deps.stdout(`mode:         ${r.mode ?? '(none)'}\n`);
  deps.stdout(`accessories:  [${r.accessories.join(', ')}]\n`);
  deps.stdout(`applied at:   ${lock.appliedAt}\n`);
  deps.stdout(`files:        ${lock.files.length}\n`);

  // Sample paths.
  const samples = lock.files.slice(0, SAMPLE_LIMIT);
  for (const f of samples) {
    deps.stdout(`  ${f.path}\n`);
  }
  if (lock.files.length > SAMPLE_LIMIT) {
    deps.stdout(`  ... and ${lock.files.length - SAMPLE_LIMIT} more\n`);
  }

  // Drift detection — per-file sha256 mismatch (or missing file).
  const drift: string[] = [];
  for (const f of lock.files) {
    const full = path.join(args.projectDir, f.path);
    try {
      await fs.stat(full);
    } catch {
      drift.push(`${f.path} (missing)`);
      continue;
    }
    const current = await sha256OfFile(full);
    if (current !== f.sha256) drift.push(f.path);
  }
  if (drift.length > 0) {
    deps.stdout(`\ndrift detected (${drift.length}):\n`);
    for (const d of drift) deps.stdout(`  drift: ${d}\n`);
  }

  // Lockfile path footer for discoverability.
  deps.stdout(`\nlockfile:     ${path.join(args.projectDir, LOCKFILE_PATH)}\n`);
  return 0;
}
