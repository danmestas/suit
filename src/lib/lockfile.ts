/**
 * Lockfile reader/writer for `suit up` / `suit off`.
 *
 * Per ADR-0012, `.suit/lock.json` records every file `suit up` emitted into the
 * project, with a sha256 per file so `suit off` can refuse to delete files the
 * user hand-edited after applying. This module is the pure data layer — no
 * imports from adapters, session, or harness logic. It owns:
 *   - the on-disk schema (zod-validated)
 *   - sha256 helpers for buffers and files
 *   - read / write / delete primitives
 *
 * Phase B (`suit up`) and Phase C (`suit off`) consume this module; nothing
 * else does in v0.5.
 */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

export const LOCKFILE_PATH = '.suit/lock.json';
const LOCKFILE_DIR = '.suit';

/**
 * How `suit up` wrote this entry, and how `suit off` should remove it:
 *
 * - `replace` (default): suit owns the whole file. `suit off` deletes the file
 *   if its current sha256 matches the recorded one.
 * - `additive`: suit appended a marker-wrapped block (e.g.
 *   `<!-- suit:outfit:NAME -->...<!-- /suit:outfit:NAME -->`) into a possibly
 *   user-authored file. The recorded sha256 is the BLOCK content's hash, not
 *   the whole-file hash. `suit off` reads the file, strips the marker block,
 *   and writes back; non-empty user content is preserved. If the block was
 *   hand-edited (block sha256 mismatch) `suit off` refuses unless `--force`.
 */
export type LockEntryMode = 'replace' | 'additive';

export interface LockEntry {
  /** Path relative to project root. Forward-slash separated for portability. */
  path: string;
  /**
   * Hex sha256. For `mode: 'replace'`, this is the file's full content hash.
   * For `mode: 'additive'`, this is the marker-block content hash.
   */
  sha256: string;
  /** Source component identifier, e.g., "outfits/backend". Informational. */
  sourceComponent: string;
  /** Removal strategy. Optional for back-compat; absent means 'replace'. */
  mode?: LockEntryMode;
}

export interface Lockfile {
  schemaVersion: 1;
  /** ISO 8601 timestamp of when `suit up` produced this lockfile. */
  appliedAt: string;
  resolution: {
    outfit: string | null;
    cut: string | null;
    accessories: string[];
  };
  files: LockEntry[];
}

const lockEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'sha256 must be 64 hex chars'),
  sourceComponent: z.string().min(1),
  mode: z.enum(['replace', 'additive']).optional(),
});

const lockfileSchema = z.object({
  schemaVersion: z.literal(1),
  appliedAt: z.string().min(1),
  resolution: z.object({
    outfit: z.string().nullable(),
    cut: z.string().nullable(),
    accessories: z.array(z.string()),
  }),
  files: z.array(lockEntrySchema),
});

/** Hex sha256 of a buffer or string. */
export function sha256OfBuffer(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Hex sha256 of a file's contents. */
export async function sha256OfFile(filepath: string): Promise<string> {
  const buf = await fs.readFile(filepath);
  return sha256OfBuffer(buf);
}

/**
 * Read `.suit/lock.json` from the given project root.
 * Returns `null` when the lockfile does not exist (a missing lockfile means
 * "no suit applied", not an error). Throws on malformed JSON, schema
 * violations, or unexpected I/O failures.
 */
export async function readLockfile(projectDir: string): Promise<Lockfile | null> {
  const target = path.join(projectDir, LOCKFILE_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`lockfile: invalid JSON in ${target}: ${(err as Error).message}`);
  }
  const result = lockfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`lockfile: schema validation failed for ${target}: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Write `.suit/lock.json` to the given project root. Creates the `.suit/` dir
 * if needed and chmods the result to 0o644.
 */
export async function writeLockfile(projectDir: string, lock: Lockfile): Promise<void> {
  // Validate before writing — refuse to persist a malformed lockfile.
  lockfileSchema.parse(lock);
  const dir = path.join(projectDir, LOCKFILE_DIR);
  const target = path.join(projectDir, LOCKFILE_PATH);
  await fs.mkdir(dir, { recursive: true });
  const body = JSON.stringify(lock, null, 2) + '\n';
  await fs.writeFile(target, body, { mode: 0o644 });
  // Explicit chmod in case the file already existed with different perms.
  await fs.chmod(target, 0o644);
}

/**
 * Delete `.suit/lock.json` and remove `.suit/` if it's now empty. Idempotent —
 * a missing lockfile or missing dir is a no-op.
 */
export async function deleteLockfile(projectDir: string): Promise<void> {
  const dir = path.join(projectDir, LOCKFILE_DIR);
  const target = path.join(projectDir, LOCKFILE_PATH);
  try {
    await fs.unlink(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Remove .suit/ only if empty; leave it alone if the user (or a future
  // feature) put other things in there.
  try {
    const entries = await fs.readdir(dir);
    if (entries.length === 0) {
      await fs.rmdir(dir);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
