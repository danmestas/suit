/**
 * `suit off` — reverse a `suit up` apply (Phase C of v0.5; ADR-0012).
 *
 * Reads `.suit/lock.json`, deletes every tracked file (refusing on sha256 drift
 * unless `--force`), prunes now-empty parent directories that the apply created,
 * and finally removes the lockfile + `.suit/` dir if it was solely ours.
 *
 * Idempotency: a missing lockfile is a no-op (exit 0 with a friendly message).
 * Drift collection is greedy — without `--force`, every hand-edited file is
 * reported in one batch before exiting non-zero, so the user sees the full list
 * rather than fixing one, re-running, and discovering another.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { LOCKFILE_PATH, deleteLockfile, readLockfile, sha256OfBuffer, sha256OfFile } from '../lockfile.js';
import { stripSuitBlocks } from '../writer.js';

/**
 * Find the suit-outfit marker block in `content` and return its body
 * (the text between the open and close markers, exclusive). Returns null if
 * no block is present.
 */
function extractSuitBlockBody(content: string): string | null {
  const m = content.match(/<!-- suit:outfit:[^>]+ -->\n([\s\S]*?)\n<!-- \/suit:outfit:[^>]+ -->/);
  return m ? m[1]! : null;
}

/**
 * Reconstruct the full marker-wrapped block string for sha verification — the
 * lockfile records the hash of `content`, which is the full
 * `<!-- ... -->\nbody\n<!-- ... -->` string (matches what up.ts wrote).
 */
function extractSuitBlockFull(content: string): string | null {
  const m = content.match(/<!-- suit:outfit:[^>]+ -->\n[\s\S]*?\n<!-- \/suit:outfit:[^>]+ -->/);
  return m ? m[0]! : null;
}

export interface RunOffArgs {
  projectDir: string;
  force: boolean;
}

export interface RunOffDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

/**
 * Walk up parent directories from `startRel` (relative to `projectDir`) toward
 * the project root. For each ancestor, if it is empty AND inside the project,
 * remove it. Stop at the project root or at the first non-empty ancestor.
 *
 * `startRel` should be the *parent* of a removed file (forward-slash separated,
 * relative to `projectDir`). The loop is best-effort: ENOENT is swallowed (the
 * dir was already gone — possibly because a sibling cleanup just removed it),
 * ENOTEMPTY is the natural stop signal.
 */
async function pruneEmptyAncestors(projectDir: string, startRel: string): Promise<void> {
  let rel = startRel;
  while (rel && rel !== '.' && rel !== '/') {
    const abs = path.join(projectDir, rel);
    let entries: string[];
    try {
      entries = await fs.readdir(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Ancestor already gone — keep walking up.
        rel = path.posix.dirname(rel);
        continue;
      }
      // ENOTDIR or other unexpected — stop the climb.
      return;
    }
    if (entries.length > 0) return;
    try {
      await fs.rmdir(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return;
      if (code !== 'ENOENT') return;
    }
    rel = path.posix.dirname(rel);
  }
}

export async function runOff(args: RunOffArgs, deps: RunOffDeps): Promise<number> {
  const lock = await readLockfile(args.projectDir);
  if (!lock) {
    deps.stdout('(no suit applied — nothing to remove)\n');
    return 0;
  }

  // Stage 1: drift preflight (non-force only). Collect ALL hand-edited files
  // in one pass so the user sees the full list before deciding how to recover.
  if (!args.force) {
    const drifted: string[] = [];
    for (const f of lock.files) {
      const full = path.join(args.projectDir, f.path);
      let exists = false;
      try {
        await fs.stat(full);
        exists = true;
      } catch {
        exists = false;
      }
      if (!exists) continue; // already gone, no drift to detect

      if (f.mode === 'additive') {
        // For additive entries the recorded sha is the marker-block hash, not
        // the whole-file hash. Find the block; absent or mutated → drift.
        const fileContent = await fs.readFile(full, 'utf8');
        const blockFull = extractSuitBlockFull(fileContent);
        if (blockFull === null) continue; // already stripped — nothing to do
        const blockSha = sha256OfBuffer(blockFull);
        if (blockSha !== f.sha256) drifted.push(f.path);
      } else {
        const currentSha = await sha256OfFile(full);
        if (currentSha !== f.sha256) drifted.push(f.path);
      }
    }
    if (drifted.length > 0) {
      for (const p of drifted) {
        deps.stderr(`suit off: target hand-edited since suit applied it: ${p}\n`);
      }
      deps.stderr(
        `suit off: refusing to delete ${drifted.length} hand-edited file${drifted.length === 1 ? '' : 's'}; ` +
          `pass --force to delete anyway, or save your changes and re-run.\n`,
      );
      return 1;
    }
  }

  // Stage 2: delete every tracked file. Track removed parent dirs so we can
  // prune empty ancestors after the deletion pass.
  const removedDirs = new Set<string>();
  let removed = 0;
  let skippedMissing = 0;
  const forcedDrift: string[] = [];

  for (const f of lock.files) {
    const full = path.join(args.projectDir, f.path);
    let exists = false;
    try {
      await fs.stat(full);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      skippedMissing++;
      continue;
    }

    if (f.mode === 'additive') {
      // Strip just the marker block from the file. If the file becomes empty
      // (only whitespace) after the strip, delete it; otherwise write the
      // remaining user content back. Drift report happens above; under
      // --force we strip regardless.
      const before = await fs.readFile(full, 'utf8');
      const blockFull = extractSuitBlockFull(before);
      if (args.force && blockFull !== null) {
        const blockSha = sha256OfBuffer(blockFull);
        if (blockSha !== f.sha256) forcedDrift.push(f.path);
      }
      const after = stripSuitBlocks(before);
      if (after.trim().length === 0) {
        await fs.unlink(full);
        const parentRel = path.posix.dirname(f.path);
        if (parentRel && parentRel !== '.' && parentRel !== '/') {
          removedDirs.add(parentRel);
        }
      } else {
        await fs.writeFile(full, after);
      }
      removed++;
      continue;
    }

    if (args.force) {
      // Re-check sha for the report. A mismatch under --force is informational,
      // not fatal — we delete anyway.
      try {
        const currentSha = await sha256OfFile(full);
        if (currentSha !== f.sha256) forcedDrift.push(f.path);
      } catch {
        // best-effort — proceed with delete
      }
    }

    try {
      await fs.unlink(full);
      removed++;
      const parentRel = path.posix.dirname(f.path);
      if (parentRel && parentRel !== '.' && parentRel !== '/') {
        removedDirs.add(parentRel);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // raced with something else removing it; treat as missing
        skippedMissing++;
        continue;
      }
      throw err;
    }
  }

  // Stage 3: prune empty parent directories. Sort by depth (deepest first) so
  // each climb starts at a leaf and walks up cleanly.
  const dirsByDepth = Array.from(removedDirs).sort(
    (a, b) => b.split('/').length - a.split('/').length,
  );
  for (const dir of dirsByDepth) {
    await pruneEmptyAncestors(args.projectDir, dir);
  }

  // Stage 4: delete the lockfile and (if empty) the `.suit/` dir.
  await deleteLockfile(args.projectDir);

  // Stage 5: report.
  deps.stdout(`Removed ${removed} file${removed === 1 ? '' : 's'} from ${args.projectDir}\n`);
  if (skippedMissing > 0) {
    deps.stdout(
      `Skipped ${skippedMissing} already-missing file${skippedMissing === 1 ? '' : 's'}\n`,
    );
  }
  if (forcedDrift.length > 0) {
    deps.stdout(
      `Force-deleted ${forcedDrift.length} hand-edited file${forcedDrift.length === 1 ? '' : 's'}:\n`,
    );
    for (const p of forcedDrift) deps.stdout(`  ${p}\n`);
  }
  deps.stdout(`Removed lockfile: ${path.join(args.projectDir, LOCKFILE_PATH)}\n`);

  return 0;
}
