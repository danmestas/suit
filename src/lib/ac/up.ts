/**
 * `suit up` — project-state mutator (Phase B of v0.5; ADR-0012).
 *
 * Reads outfit / mode / accessories from the wardrobe content dir, runs the
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
import type { Target } from '../types.js';
import type { EmittedFile, ComponentSource } from '../types.js';
import { discoverComponents } from '../discover.js';
import { findOutfit } from '../outfit.js';
import { findMode } from '../mode.js';
import { findAccessory } from '../accessory.js';
import { resolve, skillsKeepFromResolution } from '../resolution.js';
import { getAdapter } from '../../adapters/index.js';
import { loadRepoConfig } from '../config.js';
import { ProjectWriter } from '../writer.js';
import {
  LOCKFILE_PATH,
  readLockfile,
  writeLockfile,
  sha256OfBuffer,
  sha256OfFile,
  type Lockfile,
  type LockEntry,
} from '../lockfile.js';
import { runPicker } from './picker.js';

export interface RunUpArgs {
  outfit: string | null;
  mode: string | null;
  accessories: string[];
  force: boolean;
  /** Project root — files are written here; lockfile lives at <projectDir>/.suit/lock.json. */
  projectDir: string;
  /** Wardrobe content dir (built-in catalog). */
  contentDir: string;
  /** User overlay dir for outfits/modes/accessories overrides. */
  userDir: string;
  /** Whether stdin is a TTY (for picker dispatch in Phase D). */
  isTTY: boolean;
}

export interface RunUpDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

/**
 * Per-target prefix applied to adapter-emitted relative paths when writing into
 * a project tree. The build flow (suit-build) emits into `dist/<target>/` so
 * paths like `skills/foo/SKILL.md` are unambiguous. For project-state mutation
 * those paths need to land in the harness's project location.
 *
 * Notes per harness:
 *   - claude-code: skills/agents/etc. live under `.claude/`. CLAUDE.md lives at
 *     project root for project scope (see claude-code adapter — that path
 *     stays as-emitted, no prefix needed). The adapter emits `CLAUDE.md`
 *     (project-scope) or `.claude/CLAUDE.md` (user-scope); both work after the
 *     prefix.
 *   - codex: emits `AGENTS.md` at project root, no prefix.
 *   - copilot: emits `copilot-instructions.md`, also expected at root (or
 *     `.github/copilot-instructions.md` per author config — out of scope).
 *   - gemini: skills live under `.gemini/`; rules go to `GEMINI.md` (project)
 *     or `.gemini/GEMINI.md` (user). The adapter already emits the latter as
 *     `.gemini/GEMINI.md`, so only the bare-skill paths need the prefix.
 *   - pi: adapter already emits paths starting with `.pi/`; no prefix.
 *   - apm: APM packages live under per-package dirs. The state-mutator model
 *     for APM is unclear (the launcher's prelaunchComposeApm assumes the
 *     project IS the APM package). Phase B leaves APM unprefixed; the lockfile
 *     records the as-emitted path. If the wardrobe declares apm targets, the
 *     dressed project tree will receive the package dirs at root.
 */
const TARGET_PROJECT_PREFIX: Record<Target, string> = {
  'claude-code': '.claude',
  gemini: '.gemini',
  pi: '', // adapter already emits with `.pi/` prefix
  codex: '',
  copilot: '',
  apm: '',
};

/**
 * Paths the claude-code adapter emits that should NOT be prefixed with
 * `.claude/`. These are project-root files (CLAUDE.md project-scope) or
 * already-prefixed files (.claude/CLAUDE.md user-scope, .claude/settings*).
 * Anything else from claude-code (skills/, agents/, hooks/) gets the prefix.
 */
function applyTargetPrefix(target: Target, emittedPath: string): string {
  const prefix = TARGET_PROJECT_PREFIX[target];
  if (!prefix) return emittedPath;
  // Already-prefixed paths from the adapter (e.g. claude-code's
  // `.claude/CLAUDE.md` user-scope, `.claude/settings.fragment.json`) stay put.
  if (emittedPath === prefix || emittedPath.startsWith(`${prefix}/`)) {
    return emittedPath;
  }
  // Project-root files emitted at the top of the dist tree (CLAUDE.md,
  // GEMINI.md, AGENTS.md, copilot-instructions.md, .mcp.fragment.json, etc.)
  // also stay put — they're meant to live at the project root.
  if (!emittedPath.includes('/')) return emittedPath;
  return `${prefix}/${emittedPath}`;
}

interface PendingFile {
  path: string;
  content: string | Buffer;
  mode?: number;
  sha256: string;
  sourceComponent: string;
}

/**
 * Resolve the union of harness targets across the active component set.
 * `resolve()` itself only takes one target at a time, so for the multi-harness
 * fan-out we iterate.
 */
function unionTargets(
  outfitTargets: Target[],
  modeTargets: Target[] | undefined,
  accessoryTargetsList: Target[][],
): Target[] {
  const set = new Set<Target>(outfitTargets);
  if (modeTargets) for (const t of modeTargets) set.add(t);
  for (const list of accessoryTargetsList) for (const t of list) set.add(t);
  return Array.from(set);
}

/**
 * Emit every kept component's files for a single target. Returns absolute
 * project-rooted paths (with the target prefix applied) plus per-file sha256
 * and a sourceComponent label.
 *
 * The kept-component set is computed by `resolve()`'s skillsDrop list — every
 * skill not in skillsDrop is kept. Non-skill components (rules, hooks, agents,
 * mcp, plugin) are not filtered by category and are always emitted when their
 * target matches.
 */
async function emitForTarget(
  target: Target,
  catalog: ComponentSource[],
  skillsDrop: string[],
  projectDir: string,
  repoConfig: Record<string, Record<string, unknown>>,
): Promise<PendingFile[]> {
  const adapter = getAdapter(target);
  if (!adapter) {
    throw new Error(`suit up: no adapter registered for target "${target}"`);
  }
  const dropSet = new Set(skillsDrop);
  // Filter the catalog to: components whose targets include this target AND
  // (if it's a skill) whose name is not dropped by the resolver.
  const eligible = catalog.filter((c) => {
    if (!c.manifest.targets.includes(target)) return false;
    if (!adapter.supports(c)) return false;
    if (c.manifest.type === 'skill' && dropSet.has(c.manifest.name)) return false;
    return true;
  });

  const ctx = {
    config: (repoConfig[target] ?? {}) as Record<string, unknown>,
    allComponents: eligible,
    repoRoot: projectDir,
  };

  const out: PendingFile[] = [];
  for (const c of eligible) {
    const emitted: EmittedFile[] = await adapter.emit(c, ctx);
    for (const file of emitted) {
      const projectRelative = applyTargetPrefix(target, file.path);
      const buf = typeof file.content === 'string' ? Buffer.from(file.content) : file.content;
      out.push({
        path: projectRelative,
        content: file.content,
        mode: file.mode,
        sha256: sha256OfBuffer(buf),
        sourceComponent: c.relativeDir,
      });
    }
  }
  return out;
}

function dedupeByPath(files: PendingFile[]): PendingFile[] {
  const byPath = new Map<string, PendingFile>();
  for (const f of files) {
    const prior = byPath.get(f.path);
    if (!prior) {
      byPath.set(f.path, f);
      continue;
    }
    // Same path emitted twice — accept the second only if content matches.
    // Mismatched duplicates are an authoring bug (two adapters claiming the
    // same project file with different bytes); refuse rather than silently
    // overwrite.
    if (prior.sha256 !== f.sha256) {
      throw new Error(
        `suit up: two emitted files collide at "${f.path}" with different contents ` +
          `(sources: "${prior.sourceComponent}" vs "${f.sourceComponent}")`,
      );
    }
  }
  return Array.from(byPath.values());
}

function sameResolution(a: Lockfile['resolution'], b: { outfit: string | null; mode: string | null; accessories: string[] }): boolean {
  if (a.outfit !== b.outfit) return false;
  if (a.mode !== b.mode) return false;
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
      args = { ...args, outfit: picked.outfit, mode: picked.mode, accessories: picked.accessories };
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
  const outfitName = args.outfit;

  // Stage 1: load outfit, mode, accessories using the standard discovery chain.
  const foundOutfit = await findOutfit(outfitName, dirs);
  const outfitManifest = foundOutfit.manifest;

  let modeManifest;
  let modeBody: string | undefined;
  if (args.mode) {
    const found = await findMode(args.mode, dirs);
    modeManifest = found.manifest;
    modeBody = found.body;
  }

  const accessoryManifests = [];
  for (const accName of args.accessories) {
    const found = await findAccessory(accName, dirs);
    accessoryManifests.push(found.manifest);
  }

  // Stage 2: discover the wardrobe catalog (built-in content dir is the source
  // of truth for the dressed project — not the user's existing ~/.claude/...).
  const catalog = await discoverComponents(args.contentDir);

  // Stage 3: compute the harness target union.
  const targets = unionTargets(
    outfitManifest.targets,
    modeManifest?.targets,
    accessoryManifests.map((a) => a.targets),
  );

  // Stage 4: resolve once per target (resolve() requires a single target so it
  // can compute the kept-skill set deterministically; the kept set is target-
  // independent today, but the per-target call keeps the door open for future
  // target-specific resolution rules without changing this caller).
  // We still compute it once and reuse — categories/include logic is target-
  // independent — but we run resolve() with the first target as canonical.
  const canonicalResolution = resolve({
    catalog,
    outfit: outfitManifest,
    mode: modeManifest,
    accessories: accessoryManifests,
    modeBody,
    harness: targets[0],
  });

  // Stage 5: load repo config and emit per target.
  const repoConfig = await loadRepoConfig(args.projectDir);
  const allFiles: PendingFile[] = [];
  for (const target of targets) {
    const targetFiles = await emitForTarget(
      target,
      catalog,
      canonicalResolution.skillsDrop,
      args.projectDir,
      repoConfig as Record<string, Record<string, unknown>>,
    );
    allFiles.push(...targetFiles);
  }

  const pending = dedupeByPath(allFiles);

  // Stage 6: refuse-when-dirty preflight.
  const priorLock = await readLockfile(args.projectDir);
  const newResolution = {
    outfit: outfitManifest.name,
    mode: modeManifest?.name ?? null,
    accessories: accessoryManifests.map((a) => a.name),
  };

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
    .map((f) => ({ path: f.path, sha256: f.sha256, sourceComponent: f.sourceComponent }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const lock: Lockfile = {
    schemaVersion: 1,
    appliedAt: new Date().toISOString(),
    resolution: newResolution,
    files: lockEntries,
  };
  await writeLockfile(args.projectDir, lock);

  // Stage 9: report.
  const filesByTarget = new Map<Target, number>();
  // Recount emit-per-target for the report (pending is post-dedupe; we recount
  // by re-grouping using the targets we walked). Cheaper: just recompute from
  // the per-target buckets we already had.
  // Simple approach — count files whose path starts with a target prefix.
  for (const target of targets) {
    const prefix = TARGET_PROJECT_PREFIX[target];
    let count = 0;
    for (const f of pending) {
      if (prefix && (f.path === prefix || f.path.startsWith(`${prefix}/`))) count++;
      else if (!prefix) count++; // unprefixed targets get every unprefixed file (best-effort)
    }
    filesByTarget.set(target, count);
  }

  deps.stdout(`Resolved: ${formatResolution(newResolution)}\n`);
  deps.stdout(`Applied to ${args.projectDir}:\n`);
  for (const target of targets) {
    const count = filesByTarget.get(target) ?? 0;
    deps.stdout(`  ${target}: ${count} file${count === 1 ? '' : 's'}\n`);
  }
  deps.stdout(`  total: ${pending.length} file${pending.length === 1 ? '' : 's'}\n`);
  deps.stdout(`Lockfile: ${path.join(args.projectDir, LOCKFILE_PATH)}\n`);

  // Suppress unused warning — skillsKeep is reserved for a future report that
  // shows which skills were kept vs dropped by the resolver.
  void skillsKeepFromResolution;

  return 0;
}

function formatResolution(r: { outfit: string | null; mode: string | null; accessories: string[] }): string {
  const parts: string[] = [];
  parts.push(`outfit=${r.outfit ?? '(none)'}`);
  parts.push(`mode=${r.mode ?? '(none)'}`);
  parts.push(`accessories=[${r.accessories.join(', ')}]`);
  return parts.join(', ');
}
