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

/**
 * Files emitted at this path get redirected to a different on-disk location
 * by `ProjectWriter` so the harness reads them natively. The launcher path
 * (TempdirWriter) keeps the original path because suit-build's prelaunch step
 * has its own merge logic.
 *
 * `.claude/settings.fragment.json` → `.claude/settings.local.json`
 *   Claude Code reads `.claude/settings.local.json` natively (and merges it
 *   over the user's `~/.claude/settings.json`). Writing the fragment as-is
 *   means hooks defined in outfits/accessories don't fire when `claude` is
 *   invoked natively in a `suit up`-dressed project.
 *
 * `.gemini/settings.fragment.json` → `.gemini/settings.json`
 *   Gemini reads `.gemini/settings.json` natively at the project level.
 */
const PROJECT_PATH_REDIRECTS: Record<string, string> = {
  '.claude/settings.fragment.json': '.claude/settings.local.json',
  '.gemini/settings.fragment.json': '.gemini/settings.json',
};

/**
 * Files at this path get treated as additive: ProjectWriter strips any prior
 * `<!-- suit:outfit:NAME -->...<!-- /suit:outfit:NAME -->` block from any
 * existing on-disk content, then appends the new block. `suit off` strips the
 * marked block back out and preserves any user-authored content around it.
 *
 * Used for CLAUDE.md and analogous harness rules files where the user may
 * have hand-authored content suit must not clobber.
 */
const ADDITIVE_PATHS = new Set<string>([
  '.claude/CLAUDE.md',
  'CLAUDE.md',
]);

const SUIT_BLOCK_RE = /(?:^|\n)<!-- suit:outfit:[^>]+ -->\n[\s\S]*?\n<!-- \/suit:outfit:[^>]+ -->\n?/g;

export function isAdditivePath(relPath: string): boolean {
  return ADDITIVE_PATHS.has(relPath);
}

/**
 * Strip any suit-emitted marker blocks from `content`. Used by both
 * ProjectWriter (before appending the new block on `suit up`) and `suit off`
 * (to remove the block while leaving user content in place). Idempotent.
 *
 * The regex captures the leading `\n` (or start-of-file) AND the optional
 * trailing `\n`, so replacing with an empty string restores the byte sequence
 * that existed before the block was inserted — preserving any blank-line
 * separators the user authored around the block, and avoiding an extra
 * trailing newline when the block was at end-of-file.
 */
export function stripSuitBlocks(content: string): string {
  return content.replace(SUIT_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trimStart();
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
    const redirected = PROJECT_PATH_REDIRECTS[file.path];
    const effectivePath = redirected ?? file.path;

    if (isAdditivePath(effectivePath)) {
      await this.writeAdditive({ ...file, path: effectivePath });
      return;
    }

    await writeFileAt(this.destination, { ...file, path: effectivePath });
  }

  /**
   * Append `file.content` (already wrapped by the caller in
   * `<!-- suit:outfit:NAME -->...<!-- /suit:outfit:NAME -->` markers) into the
   * existing target file, after stripping any prior suit-emitted block. If the
   * target doesn't exist yet, create it with just the new block.
   */
  private async writeAdditive(file: EmittedFile): Promise<void> {
    const target = resolveInside(this.destination, file.path);
    let existing = '';
    try {
      existing = await fs.readFile(target, 'utf8');
    } catch {
      // file doesn't exist — fine, will create
    }
    const stripped = stripSuitBlocks(existing);
    const block = typeof file.content === 'string' ? file.content : file.content.toString('utf8');
    const sep = stripped.length > 0 && !stripped.endsWith('\n') ? '\n\n' : (stripped.length > 0 ? '\n' : '');
    const final = `${stripped}${sep}${block}\n`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, final, { mode: file.mode ?? 0o644 });
  }

  async symlink(source: string, relativeDest: string): Promise<void> {
    await symlinkAt(this.destination, source, relativeDest);
  }
  // Intentionally no cleanup — see class comment.
}
