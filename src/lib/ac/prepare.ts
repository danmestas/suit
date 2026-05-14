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
 *   - `--label <string>`: stamps the bundle with a caller-provided label
 *     (e.g. "agent-harness/bones-worker-3"). Surfaces in `.suit-bundle.json`
 *     for registry surveys and `suit show bundle <path>`.
 *
 * Bundle introspection:
 *   Every bundle gets a `.suit-bundle.json` at its root carrying
 *   `{ schemaVersion, outfit, cut, accessories, target, label?, suitVersion,
 *   generatedAt }`. This is metadata only — no `.suit/` dir is written, no
 *   lockfile, no preflight. Callers can `cat $BUNDLE/.suit-bundle.json | jq`
 *   or use `suit show bundle <path>` for pretty-printed output.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TARGETS, type Target } from '../types.js';
import { ProjectWriter } from '../writer.js';
import { composeBundle } from './compose.js';

export interface RunPrepareArgs {
  outfit: string;
  /** Seniority-tier overlay (issue #60). Optional for back-compat. */
  fit?: string | null;
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
  /**
   * Caller-provided human-readable label for the bundle. Recorded in
   * `.suit-bundle.json` for registry surveys and operator debugging. The
   * label is purely informational — it does NOT affect composition, the
   * bundle path, or any resolver behavior.
   */
  label?: string;
  /**
   * Suit's own version string (typically read from package.json by the CLI
   * entrypoint). Recorded in `.suit-bundle.json` so consumers can correlate
   * a bundle on disk with the suit binary that produced it.
   */
  suitVersion?: string;
  /**
   * Bundle layout shape:
   *   - `'project'` (default): bundle mirrors a project tree. Caller does
   *     `cd $BUNDLE && claude --add-dir $PROJECT`. Pre-existing behavior.
   *   - `'sidecar'`: bundle is loadable as a side-load. Caller does
   *     `cd $PROJECT && exec $BUNDLE/launch`. Loads the project's own
   *     CLAUDE.md natively (cwd auto-discovery) plus the bundle's
   *     dressing via flags. Solves the "project's own CLAUDE.md
   *     silently not loaded" gap that the project-shape recipe has.
   *
   * sidecar shape requires `--target claude-code` (it relies on
   * `--append-system-prompt-file` which is claude-code-specific) and
   * `projectPath` (so the launch script can `cd` correctly).
   */
  shape?: 'project' | 'sidecar';
  /**
   * Filesystem path the launch script will cd to before invoking the
   * harness. Required when `shape === 'sidecar'`. Recorded in the launch
   * script verbatim — make sure it's the path that should remain stable
   * across the bundle's lifetime (the project root, typically).
   */
  projectPath?: string;
}

export interface SuitBundleMetadata {
  schemaVersion: 1;
  outfit: string;
  fit?: string | null;
  cut: string | null;
  accessories: string[];
  target: Target;
  /** Optional caller-provided label. */
  label?: string;
  /** Bundle shape, omitted when 'project' (the default) for back-compat. */
  shape?: 'sidecar';
  /** suit version when the bundle was emitted. */
  suitVersion?: string;
  /** ISO-8601 UTC timestamp. */
  generatedAt: string;
}

/** File at the bundle root carrying composition metadata. */
export const BUNDLE_METADATA_FILENAME = '.suit-bundle.json';

/** Combined CLAUDE.md content for sidecar shape — loaded via `--append-system-prompt-file`. */
const SIDECAR_SYSTEM_PROMPT = 'SYSTEM_PROMPT.md';

/** Generated launch script (sidecar) — owns the recipe so callers don't have to. */
const SIDECAR_LAUNCH_SCRIPT = 'launch';

/**
 * Pending file paths whose content should be folded into SYSTEM_PROMPT.md
 * (concatenated) when emitting a sidecar bundle. Other files in `.claude/`
 * (skills, agents, hooks, commands) pass through unchanged — they resolve
 * via `--add-dir`. Root-level CLAUDE.md is the rules block; `.claude/CLAUDE.md`
 * is the additive outfit body.
 */
const SIDECAR_FOLDED_PATHS = new Set(['CLAUDE.md', '.claude/CLAUDE.md']);

/**
 * Transform a project-shape pending file list into a sidecar layout.
 * Concatenates root CLAUDE.md + .claude/CLAUDE.md content into SYSTEM_PROMPT.md
 * at the bundle root; everything else passes through.
 */
function adaptSidecarShape(
  pending: import('./compose.js').PendingFile[],
): import('./compose.js').PendingFile[] {
  const fragments: string[] = [];
  const remaining: import('./compose.js').PendingFile[] = [];
  for (const f of pending) {
    if (SIDECAR_FOLDED_PATHS.has(f.path)) {
      const text = typeof f.content === 'string' ? f.content : f.content.toString('utf8');
      fragments.push(text.trim());
    } else {
      remaining.push(f);
    }
  }
  if (fragments.length > 0) {
    const combined = fragments.filter((s) => s.length > 0).join('\n\n') + '\n';
    remaining.push({
      path: SIDECAR_SYSTEM_PROMPT,
      content: combined,
      sha256: '', // not lockfile-tracked; sha not needed
      sourceComponent: '(sidecar concat)',
    });
  }
  return remaining;
}

/**
 * Emit `<bundle>/launch` — a generated bash script that owns the recipe for
 * launching the harness against this bundle. Callers do `exec $BUNDLE/launch`
 * instead of assembling 4-5 flags themselves. When the harness CLI's flag
 * surface changes, suit updates this script and every consumer benefits
 * silently.
 */
async function emitSidecarLaunchScript(
  bundleDir: string,
  projectPath: string,
): Promise<void> {
  // Single-quote shell escaping: replace any embedded ' with '\'' and
  // wrap the whole value in single quotes. Safe against spaces, quotes, $vars.
  const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

  const sysPrompt = path.join(bundleDir, SIDECAR_SYSTEM_PROMPT);
  const script =
    `#!/usr/bin/env bash\n` +
    `# Auto-generated by 'suit prepare --shape sidecar'.\n` +
    `# Owns the launch recipe so callers don't have to assemble it themselves.\n` +
    `# Caller usage: exec ${path.join(bundleDir, SIDECAR_LAUNCH_SCRIPT)} [extra-flags...]\n` +
    `set -euo pipefail\n` +
    `cd ${sq(projectPath)}\n` +
    `exec claude \\\n` +
    `  --append-system-prompt-file ${sq(sysPrompt)} \\\n` +
    `  --add-dir ${sq(bundleDir)} \\\n` +
    `  "$@"\n`;

  const launchPath = path.join(bundleDir, SIDECAR_LAUNCH_SCRIPT);
  await fs.writeFile(launchPath, script);
  await fs.chmod(launchPath, 0o755);
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

  const shape = args.shape ?? 'project';

  // Sidecar requires claude-code (it uses --append-system-prompt-file, which
  // is claude-code-specific) and a project path (so the launch script can cd).
  if (shape === 'sidecar') {
    if (args.target !== 'claude-code') {
      deps.stderr(
        `suit prepare: --shape sidecar only supported for --target claude-code (got "${args.target}")\n`,
      );
      return 2;
    }
    if (!args.projectPath || args.projectPath.length === 0) {
      deps.stderr('suit prepare: --shape sidecar requires --project <path>\n');
      return 2;
    }
  }

  // Compose the bundle. Errors (missing outfit, resolver failure, etc.)
  // propagate to the top-level CLI catch — same shape as `suit up`.
  const composed = await composeBundle(
    {
      outfit: args.outfit,
      fit: args.fit ?? null,
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

  // Sidecar shape: rewrite pending so root CLAUDE.md + .claude/CLAUDE.md fold
  // into SYSTEM_PROMPT.md at the bundle root. This must happen BEFORE dry-run
  // so the preview reflects what the writer would do.
  const finalPending = shape === 'sidecar' ? adaptSidecarShape(composed.pending) : composed.pending;

  // --dry-run: print the file list without writing. Skips tempdir creation
  // entirely so a dry-run leaves no on-disk artifacts.
  if (args.dryRun) {
    for (const f of finalPending) {
      const size =
        typeof f.content === 'string'
          ? Buffer.byteLength(f.content, 'utf8')
          : f.content.length;
      deps.stdout(`${f.path}\t${size}\t${f.sourceComponent}\n`);
    }
    if (shape === 'sidecar') {
      // Note the launch script — emitted at write time, not in pending.
      deps.stdout(`${SIDECAR_LAUNCH_SCRIPT}\t(generated)\t(sidecar launch)\n`);
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
  for (const f of finalPending) {
    await writer.write({ path: f.path, content: f.content, mode: f.mode });
  }

  // Sidecar: emit the launch script alongside the dressing files. Caller
  // invokes `exec $BUNDLE/launch` instead of assembling claude flags.
  if (shape === 'sidecar') {
    await emitSidecarLaunchScript(tempdir, args.projectPath!);
  }

  // Stamp the bundle with introspection metadata. Single file at bundle root —
  // not a `.suit/` dir, since prepare is intentionally stateless. Consumers
  // can `cat $BUNDLE/.suit-bundle.json | jq` or use `suit show bundle <path>`.
  const metadata: SuitBundleMetadata = {
    schemaVersion: 1,
    outfit: args.outfit,
    ...(args.fit !== null && args.fit !== undefined ? { fit: args.fit } : {}),
    cut: args.cut,
    accessories: args.accessories,
    target: args.target,
    ...(args.label !== undefined ? { label: args.label } : {}),
    ...(shape === 'sidecar' ? { shape: 'sidecar' as const } : {}),
    ...(args.suitVersion !== undefined ? { suitVersion: args.suitVersion } : {}),
    generatedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(tempdir, BUNDLE_METADATA_FILENAME),
    JSON.stringify(metadata, null, 2) + '\n',
  );

  // --quiet drops the trailing newline so callers can `BUNDLE=$(suit prepare
  // ... --quiet)` without a stray `\n` in the capture. Without --quiet we
  // keep the trailing newline — matches existing behavior.
  deps.stdout(args.quiet ? tempdir : `${tempdir}\n`);
  return 0;
}
