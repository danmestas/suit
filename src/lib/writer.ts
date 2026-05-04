/**
 * Writer abstraction for adapter / prelaunch emit output.
 *
 * Today's adapters return `EmittedFile[]`, and the AC session orchestrator
 * (`src/lib/ac/session.ts`) writes those files into a tempdir under
 * `/tmp/ac-prelaunch-<rand>/`. v0.5's `suit up` (Phase B) needs the same emit
 * code to write into the project root instead. The Writer interface is the
 * sink — pass `TempdirWriter` for the existing per-session model and
 * `ProjectWriter` for the state-mutator model.
 *
 * Both writers resolve relative `EmittedFile.path` against their `destination`.
 * Cleanup is tempdir-only; `ProjectWriter` intentionally has no cleanup hook
 * (the project tree is permanent until `suit off` removes the lockfile-tracked
 * files).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EmittedFile } from './types.js';

export interface Writer {
  /** Where files are being written (absolute path). Used for logging. */
  destination: string;
  /** Write one emitted file. May overwrite existing content. */
  write(file: EmittedFile): Promise<void>;
  /** Symlink an existing source file/dir into the destination. Used for project mirroring. */
  symlink(source: string, relativeDest: string): Promise<void>;
  /** Cleanup hook (tempdir-only; absent for ProjectWriter). */
  cleanup?: () => Promise<void>;
}

/**
 * Resolve `relativePath` against `destination` and ensure the result stays
 * inside `destination`. Guards against EmittedFile entries whose `path`
 * contains `..` segments — composition bugs shouldn't be able to escape the
 * sink.
 */
function resolveInside(destination: string, relativePath: string): string {
  const resolved = path.resolve(destination, relativePath);
  const dest = path.resolve(destination);
  // path.relative returns '..' or starts with '..' + sep when escaping.
  const rel = path.relative(dest, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`writer: path escapes destination (${relativePath})`);
  }
  return resolved;
}

async function writeFileAt(destination: string, file: EmittedFile): Promise<void> {
  const target = resolveInside(destination, file.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, file.content, { mode: file.mode ?? 0o644 });
  // fs.writeFile honours `mode` only on file creation. If the file already
  // existed, mtime is updated but mode is preserved — explicitly chmod so the
  // declared mode wins on overwrite as well.
  if (file.mode !== undefined) {
    await fs.chmod(target, file.mode);
  }
}

async function symlinkAt(destination: string, source: string, relativeDest: string): Promise<void> {
  const target = resolveInside(destination, relativeDest);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Best-effort: if a previous file/symlink exists at the target, remove it
  // first so symlink() doesn't fail with EEXIST. Matches the prelaunch flow's
  // expectation of a fresh tempdir.
  try {
    await fs.lstat(target);
    await fs.rm(target, { recursive: true, force: true });
  } catch {
    // not present — fine
  }
  await fs.symlink(source, target);
}

export class TempdirWriter implements Writer {
  destination: string;

  private constructor(dir: string) {
    this.destination = dir;
  }

  /**
   * Create a fresh tempdir under the OS tempdir with the given prefix and
   * return a Writer rooted at it. Prefix defaults to `ac-prelaunch-` to match
   * the historical layout the AC session orchestrator produced.
   */
  static async create(prefix = 'ac-prelaunch-'): Promise<TempdirWriter> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    return new TempdirWriter(dir);
  }

  async write(file: EmittedFile): Promise<void> {
    await writeFileAt(this.destination, file);
  }

  async symlink(source: string, relativeDest: string): Promise<void> {
    await symlinkAt(this.destination, source, relativeDest);
  }

  cleanup = async (): Promise<void> => {
    try {
      await fs.rm(this.destination, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
}

export class ProjectWriter implements Writer {
  destination: string;

  /**
   * Construct a writer rooted at the project directory. Caller owns lifetime —
   * there is no cleanup; `suit off` (Phase C) reads the lockfile to remove
   * tracked files.
   */
  constructor(projectDir: string) {
    this.destination = path.resolve(projectDir);
  }

  async write(file: EmittedFile): Promise<void> {
    await writeFileAt(this.destination, file);
  }

  async symlink(source: string, relativeDest: string): Promise<void> {
    await symlinkAt(this.destination, source, relativeDest);
  }
  // Intentionally no cleanup — see class comment.
}
