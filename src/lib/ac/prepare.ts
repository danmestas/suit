/**
 * `suit prepare` — emit a dressed-project bundle to a fresh tempdir and print
 * its path. Stateless; the project tree is not touched.
 *
 * Use case (issue #36): an external orchestrator-of-workers harness needs to
 * spawn N child agents in a single shared cwd, each with a different outfit /
 * cut / accessory combination. `suit up` writes into `<cwd>/.claude/` so all
 * workers in the same cwd would share dressing. `suit claude --outfit X`
 * decouples per-session config but couples bundle prep with launch — it owns
 * the tempdir and the harness exec, so external wrappers can't compose.
 *
 * `suit prepare` is the missing seam: same composition pipeline as `suit up`
 * (shared via composeBundle in compose.ts), but the destination is a fresh
 * tempdir under `<os.tmpdir()>/suit-prepare-<rand>/` (e.g. `/tmp/...` on Linux,
 * `/var/folders/.../T/...` on macOS) and the cleanup contract belongs to the
 * caller — this command prints the path and exits. The caller may then point
 * its agent at the bundle (e.g. claude's `--add-dir`), or symlink it into a
 * per-worker config root, and is responsible for `rm -rf`-ing it when done.
 * Single target only on the first cut; multi-target opens questions about
 * combined-prefix layouts that don't have answers yet.
 *
 * Differences vs `suit up`:
 *   - no lockfile (the bundle is ephemeral; the caller decides its lifetime)
 *   - no preflight (a fresh tempdir is empty by construction)
 *   - no `.suit/` dir written
 *   - stdout is the path only — diagnostic chatter goes to stderr so the
 *     stdout payload stays machine-friendly.
 *
 * Modifiers:
 *   - `--quiet`: stdout is exactly the bundle path with no trailing newline,
 *     so callers using `BUNDLE=$(suit prepare ... --quiet)` get a clean
 *     capture without a lone `\n` at the end. Suppresses informational stderr
 *     chatter; errors still print and still exit non-zero.
 *   - `--dry-run`: composes the bundle but skips the writer entirely. Stdout
 *     emits one tab-separated line per pending file (`<path>\t<size>\t<source>`)
 *     so callers can preview without committing to disk.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TARGETS, type Target } from '../types.js';
import { ProjectWriter } from '../writer.js';
import { composeBundle } from './compose.js';

export interface RunPrepareArgs {
  outfit: string;
  cut: string | null;
  accessories: string[];
  target: Target;
  /** Project root used for repoConfig + resolver context. NOT a write destination. */
  projectDir: string;
  contentDir: string;
  userDir: string;
  /**
   * Stdout becomes EXACTLY the bundle path with no trailing newline.
   * Callers using `BUNDLE=$(suit prepare ... --quiet)` get a clean capture.
   * Errors still emit to stderr and still exit non-zero.
   */
  quiet?: boolean;
  /**
   * Skip the writer; emit one tab-separated line per pending file
   * (`<path>\t<size>\t<sourceComponent>`). No tempdir is created.
   * Useful for previewing what an outfit/cut/accessory combination produces.
   */
  dryRun?: boolean;
}

export interface RunPrepareDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const TEMPDIR_PREFIX = 'suit-prepare-';

export async function runPrepare(
  args: RunPrepareArgs,
  deps: RunPrepareDeps,
): Promise<number> {
  if (!TARGETS.includes(args.target)) {
    deps.stderr(
      `suit prepare: unknown --target "${args.target}" (known: ${TARGETS.join(', ')})\n`,
    );
    return 2;
  }

  // Compose the bundle. Errors (missing outfit, resolver failure, etc.)
  // propagate to the top-level CLI catch — same shape as `suit up`.
  const composed = await composeBundle(
    {
      outfit: args.outfit,
      cut: args.cut,
      accessories: args.accessories,
      targets: [args.target],
      projectDir: args.projectDir,
      contentDir: args.contentDir,
      userDir: args.userDir,
    },
    { stderr: deps.stderr },
  );

  // Sanity-check: the resolved outfit must declare this target. composeBundle
  // happily emits zero files for an unsupported target (the per-target adapter
  // filter drops every component); surface that loud rather than write an
  // empty bundle the caller will then debug.
  if (composed.pending.length === 0) {
    deps.stderr(
      `suit prepare: nothing to emit for target "${args.target}". ` +
        `Verify the outfit/cut/accessories declare this target in their frontmatter.\n`,
    );
    return 1;
  }

  // --dry-run: print the file list without writing. Skips tempdir creation
  // entirely so a dry-run leaves no on-disk artifacts.
  if (args.dryRun) {
    for (const f of composed.pending) {
      const size =
        typeof f.content === 'string'
          ? Buffer.byteLength(f.content, 'utf8')
          : f.content.length;
      deps.stdout(`${f.path}\t${size}\t${f.sourceComponent}\n`);
    }
    return 0;
  }

  // Now create the tempdir. Doing this AFTER compose succeeds means a failed
  // resolution doesn't leave orphan tempdirs behind.
  const tempdir = await fs.mkdtemp(path.join(os.tmpdir(), TEMPDIR_PREFIX));

  // ProjectWriter rooted at the tempdir gives us identical write semantics to
  // `suit up`: path redirects, additive-block strip+append (a no-op on a
  // fresh tempdir but keeps behavior consistent if a caller ever points
  // `prepare` at a non-empty dir in the future).
  const writer = new ProjectWriter(tempdir);
  for (const f of composed.pending) {
    await writer.write({ path: f.path, content: f.content, mode: f.mode });
  }

  // --quiet drops the trailing newline so callers can `BUNDLE=$(suit prepare
  // ... --quiet)` without a stray `\n` in the capture. Without --quiet we
  // keep the trailing newline — matches existing behavior.
  deps.stdout(args.quiet ? tempdir : `${tempdir}\n`);
  return 0;
}
