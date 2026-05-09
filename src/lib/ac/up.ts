/**
 * `suit up` — project-state mutator (Phase B of v0.5; ADR-0012).
 *
 * Reads outfit / cut / accessories from the wardrobe content dir, runs the
 * standard resolver, calls every per-target adapter's `emit()` to produce
 * `EmittedFile[]`, applies a target-specific project prefix (`.claude/` for
 * claude-code, `.gemini/` for gemini, etc. — see TARGET_PROJECT_PREFIX), and
 * writes the result through `ProjectWriter` after a refuse-when-dirty preflight.
 *
 * Phase B ships the non-interactive path only:
 *   - `--outfit` is required.
 *   - On a TTY without `--outfit` we exit 2 with a "picker not yet implemented"
 *     message; the TTY guard becomes Phase D's picker dispatch point.
 *   - Non-TTY without `--outfit` is the standard CLI usage error.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectWriter } from '../writer.js';
import {
  LOCKFILE_PATH,
  readLockfile,
  writeLockfile,
  sha256OfFile,
  type Lockfile,
  type LockEntry,
} from '../lockfile.js';
import { runPicker } from './picker.js';
import { composeBundle, countFilesByTarget, type PendingFile } from './compose.js';

export interface RunUpArgs {
  outfit: string | null;
  cut: string | null;
  accessories: string[];
  force: boolean;
  /** Project root — files are written here; lockfile lives at <projectDir>/.suit/lock.json. */
  projectDir: string;
  /** Wardrobe content dir (built-in catalog). */
  contentDir: string;
  /** User overlay dir for outfits/cuts/accessories overrides. */
  userDir: string;
  /** Whether stdin is a TTY (for picker dispatch in Phase D). */
  isTTY: boolean;
}

export interface RunUpDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

/**
 * Per-target file-count helper for the post-apply report. Imported via
 * `countFilesByTarget` from compose.ts. The full prefix table also lives there.
 *
 * Per-harness emit conventions (notes for callers, not enforced here):
 *   - claude-code: skills/agents/etc. land under `.claude/`. Adapter emits
 *     `CLAUDE.md` (project-scope) or `.claude/CLAUDE.md` (user-scope) for
 *     rules; both end up at the right path after the prefix.
 *   - codex: emits `AGENTS.md` at project root, no prefix.
 *   - copilot: emits `copilot-instructions.md` at root.
 *   - gemini: skills live under `.gemini/`.
 *   - pi: adapter already emits paths starting with `.pi/`; no prefix.
 *   - apm: state-mutator model unclear; package dirs land at root unprefixed.
 */

function sameResolution(a: Lockfile['resolution'], b: { outfit: string | null; cut: string | null; accessories: string[] }): boolean {
  if (a.outfit !== b.outfit) return false;
  if (a.cut !== b.cut) return false;
  if (a.accessories.length !== b.accessories.length) return false;
  for (let i = 0; i < a.accessories.length; i++) {
    if (a.accessories[i] !== b.accessories[i]) return false;
  }
  return true;
}

export async function runUp(args: RunUpArgs, deps: RunUpDeps): Promise<number> {
  const dirs = {
    projectDir: args.projectDir,
    userDir: args.userDir,
    builtinDir: args.contentDir,
  };

  // TTY guard: missing outfit on a TTY → Phase D interactive picker.
  // Non-TTY missing outfit → CLI usage error.
  if (!args.outfit) {
    if (!args.isTTY) {
      deps.stderr('suit up: --outfit is required (use a TTY for the interactive picker)\n');
      return 2;
    }
    try {
      const picked = await runPicker(dirs, deps);
      args = { ...args, outfit: picked.outfit, cut: picked.cut, accessories: picked.accessories };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.stderr(`suit up: ${msg}\n`);
      return 1;
    }
  }

  // After TTY-picker dispatch, outfit is guaranteed non-null. Narrow for TS.
  if (!args.outfit) {
    deps.stderr('suit up: --outfit is required\n');
    return 2;
  }

  // Stages 1-5b run through the shared composeBundle helper (also used by
  // `suit prepare`). Returns the final pending file list with redirects
  // applied, the explicit `.claude/CLAUDE.md` outfit-body block injected,
  // and any ADDITIVE_PATHS entries marker-wrapped. Errors propagate — the
  // top-level CLI catch turns them into stderr + exit 1.
  const composed = await composeBundle(
    {
      outfit: args.outfit,
      cut: args.cut,
      accessories: args.accessories,
      projectDir: args.projectDir,
      contentDir: args.contentDir,
      userDir: args.userDir,
    },
    { stderr: deps.stderr },
  );
  const { pending, targets } = composed;
  const newResolution = composed.resolution;

  // Stage 5b: marker-wrap any pending file whose path lives in writer's
  // ADDITIVE_PATHS but whose entry isn't already lockMode='additive'. Without
  // this, root `CLAUDE.md` (emitted by the claude-code adapter for
  // project-scope rules) goes into the lockfile as mode='replace' but gets
  // written through ProjectWriter.writeAdditive — the recorded sha doesn't
  // match the on-disk content (off-by-trailing-newline) AND `suit off` would
  // delete the whole file even when the user has surrounding hand-authored
  // content. Wrapping aligns these paths with the explicit `.claude/CLAUDE.md`
  // injection above; both go in as marker blocks the writer can strip back
  // out without touching user content.
  //
  // Skip paths that already have an additive entry (today: only
  // `.claude/CLAUDE.md` from the explicit injection above) — the existing
  // entry already does the right thing, and re-wrapping the adapter's
  // duplicate emission would have writeAdditive strip the first wrap before
  // appending the second. See issue #38.
  const additiveAlready = new Set(
    pending.filter((f) => f.lockMode === 'additive').map((f) => f.path),
  );
  for (const f of pending) {
    if (f.lockMode === 'additive') continue;
    if (!isAdditivePath(f.path)) continue;
    if (additiveAlready.has(f.path)) continue;
    const body = typeof f.content === 'string' ? f.content : f.content.toString('utf8');
    const trimmed = body.trim();
    if (trimmed.length === 0) continue; // empty body — leave as-is, nothing meaningful to wrap
    const wrapped = `<!-- suit:outfit:${outfitName} -->\n${trimmed}\n<!-- /suit:outfit:${outfitName} -->`;
    f.content = wrapped;
    f.lockMode = 'additive';
    f.sha256 = sha256OfBuffer(wrapped);
  }

  // Stage 6: refuse-when-dirty preflight.
  const priorLock = await readLockfile(args.projectDir);

  if (priorLock && !args.force && !sameResolution(priorLock.resolution, newResolution)) {
    const prior = formatResolution(priorLock.resolution);
    deps.stderr(
      `suit up: project already dressed: ${prior}. ` +
        `Run \`suit off\` first, or pass --force to switch.\n`,
    );
    return 1;
  }

  // Build a sha256 lookup for the prior lockfile so we can recognize re-applies.
  const priorBySha = new Map<string, string>(); // path → sha256
  if (priorLock) {
    for (const f of priorLock.files) priorBySha.set(f.path, f.sha256);
  }

  if (!args.force) {
    for (const f of pending) {
      // Additive entries are designed to share the file with user content —
      // they don't refuse-when-dirty against the whole-file hash. The block
      // sha is what matters; ProjectWriter strips any prior block before
      // appending, so an existing CLAUDE.md the user authored is fine.
      if (f.lockMode === 'additive') continue;

      const fullPath = path.join(args.projectDir, f.path);
      let exists = false;
      try {
        await fs.stat(fullPath);
        exists = true;
      } catch {
        exists = false;
      }
      if (!exists) continue;

      const priorSha = priorBySha.get(f.path);
      if (priorSha === undefined) {
        deps.stderr(`suit up: target exists and is not suit-managed: ${f.path}\n`);
        return 1;
      }
      // The file is tracked. Verify its current sha256 still matches what we
      // recorded — otherwise it was hand-edited since suit applied it.
      const currentSha = await sha256OfFile(fullPath);
      if (currentSha !== priorSha) {
        deps.stderr(`suit up: target hand-edited since suit applied it: ${f.path}\n`);
        return 1;
      }
      // priorSha === currentSha → safe to overwrite.
    }
  }

  // Stage 7: write everything via ProjectWriter.
  const writer = new ProjectWriter(args.projectDir);
  for (const f of pending) {
    await writer.write({ path: f.path, content: f.content, mode: f.mode });
  }

  // Stage 8: persist the lockfile.
  const lockEntries: LockEntry[] = pending
    .map((f) => {
      const entry: LockEntry = { path: f.path, sha256: f.sha256, sourceComponent: f.sourceComponent };
      if (f.lockMode && f.lockMode !== 'replace') entry.mode = f.lockMode;
      return entry;
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const lock: Lockfile = {
    schemaVersion: 1,
    appliedAt: new Date().toISOString(),
    resolution: newResolution,
    files: lockEntries,
  };
  await writeLockfile(args.projectDir, lock);

  // Stage 9: report.
  const filesByTarget = countFilesByTarget(pending, targets);

  deps.stdout(`Resolved: ${formatResolution(newResolution)}\n`);
  deps.stdout(`Applied to ${args.projectDir}:\n`);
  for (const target of targets) {
    const count = filesByTarget.get(target) ?? 0;
    deps.stdout(`  ${target}: ${count} file${count === 1 ? '' : 's'}\n`);
  }
  deps.stdout(`  total: ${pending.length} file${pending.length === 1 ? '' : 's'}\n`);
  deps.stdout(`Lockfile: ${path.join(args.projectDir, LOCKFILE_PATH)}\n`);

  return 0;
}

function formatResolution(r: { outfit: string | null; cut: string | null; accessories: string[] }): string {
  const parts: string[] = [];
  parts.push(`outfit=${r.outfit ?? '(none)'}`);
  parts.push(`cut=${r.cut ?? '(none)'}`);
  parts.push(`accessories=[${r.accessories.join(', ')}]`);
  return parts.join(', ');
}
