/**
 * `suit off` — reverse a `suit up` apply (Phase C of v0.5; ADR-0012).
 *
 * Reads `.suit/lock.json`, deletes every tracked file (refusing on sha256 drift
 * unless `--force`), prunes now-empty parent directories that the apply created,
 * and finally removes the lockfile + `.suit/` dir if it was solely ours.
 *
 * Injection awareness (slice e/4): a lockfile may also carry an `injected` list
 * (components pushed by `suit inject`). Those files use the IDENTICAL LockEntry
 * removal contract as `up`-applied `files[]`, so both flow through one shared
 * per-file path here — drift scan, delete/strip, dir-prune, and tallies all
 * treat an injected file the same as an up file. Without this, an inject-only
 * lockfile (files:[], injected:[...]) would have its lockfile deleted while the
 * injected files were orphaned on disk.
 *
 * `--keep-injected`: remove only the `up`-applied files and REWRITE the lockfile
 * with an empty `files`/reset `resolution` but the `injected` list preserved, so
 * a worker's injected components survive a teardown of the up-applied outfit. If
 * there are no injected entries, it degrades to a normal full `off`.
 *
 * Idempotency: a missing lockfile is a no-op (exit 0 with a friendly message).
 * Drift collection is greedy — without `--force`, every hand-edited file is
 * reported in one batch before exiting non-zero, so the user sees the full list
 * rather than fixing one, re-running, and discovering another.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LOCKFILE_PATH,
  deleteLockfile,
  readLockfile,
  sha256OfBuffer,
  sha256OfFile,
  writeLockfile,
  type LockEntry,
} from '../lockfile.js';
import { extractSuitBlockFull, stripSuitBlocks } from '../writer.js';

export interface RunOffArgs {
  projectDir: string;
  force: boolean;
  /**
   * Remove only the `up`-applied `files[]`; leave every `injected[].files` on
   * disk and rewrite (rather than delete) the lockfile so the injected entries
   * survive. No-op extra behavior when the lockfile has no injected entries —
   * in that case `off` is a normal full teardown.
   */
  keepInjected?: boolean;
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

/**
 * Drift verdict for a single tracked file. `null` means "no drift to report"
 * (in-sync, already stripped, or already gone). A string means the relative
 * path drifted and should be collected for the batch refusal.
 */
async function detectDrift(projectDir: string, f: LockEntry): Promise<string | null> {
  const full = path.join(projectDir, f.path);
  let exists = false;
  try {
    await fs.stat(full);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) return null; // already gone, no drift to detect

  if (f.mode === 'additive') {
    // For additive entries the recorded sha is the marker-block hash, not the
    // whole-file hash. Find the block; absent → already stripped (no drift),
    // present-but-mutated → drift.
    const fileContent = await fs.readFile(full, 'utf8');
    const blockFull = extractSuitBlockFull(fileContent);
    if (blockFull === null) return null; // already stripped — nothing to do
    const blockSha = sha256OfBuffer(blockFull);
    return blockSha !== f.sha256 ? f.path : null;
  }

  const currentSha = await sha256OfFile(full);
  return currentSha !== f.sha256 ? f.path : null;
}

/** Mutable tallies threaded through the per-file removal pass. */
interface RemovalState {
  removedDirs: Set<string>;
  removed: number;
  skippedMissing: number;
  forcedDrift: string[];
}

/**
 * Remove a single tracked file using the contract shared by `up`-applied and
 * injected entries:
 *   - missing on disk → counted as skippedMissing, no-op
 *   - additive → strip the marker block; delete the host file if it becomes
 *     empty, otherwise write the remaining user content back
 *   - replace → unlink the whole file
 * Under `--force`, a sha mismatch is recorded in `forcedDrift` (informational,
 * not fatal — the drift refusal already happened in the preflight). Removed
 * parents are registered for the later dir-prune pass.
 */
async function removeTrackedFile(
  projectDir: string,
  f: LockEntry,
  force: boolean,
  state: RemovalState,
): Promise<void> {
  const full = path.join(projectDir, f.path);
  let exists = false;
  try {
    await fs.stat(full);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) {
    state.skippedMissing++;
    return;
  }

  if (f.mode === 'additive') {
    const before = await fs.readFile(full, 'utf8');
    const blockFull = extractSuitBlockFull(before);
    if (force && blockFull !== null) {
      const blockSha = sha256OfBuffer(blockFull);
      if (blockSha !== f.sha256) state.forcedDrift.push(f.path);
    }
    const after = stripSuitBlocks(before);
    if (after.trim().length === 0) {
      await fs.unlink(full);
      const parentRel = path.posix.dirname(f.path);
      if (parentRel && parentRel !== '.' && parentRel !== '/') {
        state.removedDirs.add(parentRel);
      }
    } else {
      await fs.writeFile(full, after);
    }
    state.removed++;
    return;
  }

  if (force) {
    // Re-check sha for the report. A mismatch under --force is informational.
    try {
      const currentSha = await sha256OfFile(full);
      if (currentSha !== f.sha256) state.forcedDrift.push(f.path);
    } catch {
      // best-effort — proceed with delete
    }
  }

  try {
    await fs.unlink(full);
    state.removed++;
    const parentRel = path.posix.dirname(f.path);
    if (parentRel && parentRel !== '.' && parentRel !== '/') {
      state.removedDirs.add(parentRel);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // raced with something else removing it; treat as missing
      state.skippedMissing++;
      return;
    }
    throw err;
  }
}

export async function runOff(args: RunOffArgs, deps: RunOffDeps): Promise<number> {
  const lock = await readLockfile(args.projectDir);
  if (!lock) {
    deps.stdout('(no suit applied — nothing to remove)\n');
    return 0;
  }

  const injectedComponents = lock.injected ?? [];
  const injectedFiles: LockEntry[] = injectedComponents.flatMap((c) => c.files);
  // `--keep-injected` only means anything if there's something to keep.
  const keepInjected = args.keepInjected === true && injectedComponents.length > 0;

  // Stage 1: drift preflight (non-force only). Collect ALL hand-edited files —
  // up-applied AND injected — in one pass so the user sees the full list before
  // deciding how to recover. A drifted injected file reads the same as a
  // drifted up file. Under --keep-injected we skip injected files (we're
  // leaving them on disk, so their on-disk state is none of our business).
  if (!args.force) {
    const drifted: string[] = [];
    const scanTargets: LockEntry[] = keepInjected
      ? [...lock.files]
      : [...lock.files, ...injectedFiles];
    for (const f of scanTargets) {
      const drift = await detectDrift(args.projectDir, f);
      if (drift !== null) drifted.push(drift);
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

  // Stage 2: remove tracked files via the shared per-file path. up-applied
  // files always; injected files unless --keep-injected.
  const state: RemovalState = {
    removedDirs: new Set<string>(),
    removed: 0,
    skippedMissing: 0,
    forcedDrift: [],
  };

  for (const f of lock.files) {
    await removeTrackedFile(args.projectDir, f, args.force, state);
  }

  let injectedRemovedFiles = 0;
  let injectedRemovedComponents = 0;
  if (!keepInjected) {
    for (const c of injectedComponents) {
      const before = state.removed;
      for (const f of c.files) {
        await removeTrackedFile(args.projectDir, f, args.force, state);
      }
      const thisComponentRemoved = state.removed - before;
      injectedRemovedFiles += thisComponentRemoved;
      if (thisComponentRemoved > 0) injectedRemovedComponents++;
    }
  }

  // Stage 3: prune empty parent directories. Sort by depth (deepest first) so
  // each climb starts at a leaf and walks up cleanly.
  const dirsByDepth = Array.from(state.removedDirs).sort(
    (a, b) => b.split('/').length - a.split('/').length,
  );
  for (const dir of dirsByDepth) {
    await pruneEmptyAncestors(args.projectDir, dir);
  }

  // Stage 4: lockfile teardown. Default removes everything then deletes the
  // lockfile. --keep-injected (with injected entries present) rewrites it with
  // an empty up-resolution but the injected list intact.
  if (keepInjected) {
    const rewritten = {
      ...lock,
      files: [],
      resolution: {
        outfit: null,
        ...(lock.resolution.fit !== undefined ? { fit: null } : {}),
        cut: null,
        accessories: [],
      },
      injected: injectedComponents,
    };
    await writeLockfile(args.projectDir, rewritten);
  } else {
    await deleteLockfile(args.projectDir);
  }

  // Stage 5: report.
  deps.stdout(`Removed ${state.removed} file${state.removed === 1 ? '' : 's'} from ${args.projectDir}\n`);
  if (state.skippedMissing > 0) {
    deps.stdout(
      `Skipped ${state.skippedMissing} already-missing file${state.skippedMissing === 1 ? '' : 's'}\n`,
    );
  }
  if (injectedRemovedFiles > 0) {
    deps.stdout(
      `Removed ${injectedRemovedFiles} injected file(s) (${injectedRemovedComponents} component(s))\n`,
    );
  }
  if (keepInjected) {
    const keptFiles = injectedFiles.length;
    deps.stdout(
      `Kept ${keptFiles} injected file(s) (${injectedComponents.length} component(s)); lockfile retained\n`,
    );
  }
  if (state.forcedDrift.length > 0) {
    deps.stdout(
      `Force-deleted ${state.forcedDrift.length} hand-edited file${state.forcedDrift.length === 1 ? '' : 's'}:\n`,
    );
    for (const p of state.forcedDrift) deps.stdout(`  ${p}\n`);
  }
  if (!keepInjected) {
    deps.stdout(`Removed lockfile: ${path.join(args.projectDir, LOCKFILE_PATH)}\n`);
  }

  return 0;
}
