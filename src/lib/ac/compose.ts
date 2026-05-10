/**
 * Bundle composition — discover + resolve + emit + dedupe + additive-wrap.
 *
 * Both `suit up` (project-state mutator) and `suit prepare` (stateless tempdir
 * bundle emitter, ADR for #36) take the same outfit/cut/accessory inputs and
 * produce the same on-disk file set; only the destination differs. This module
 * owns the shared pipeline, returning a list of `PendingFile`s ready for the
 * caller to write into wherever it wants — `ProjectWriter` rooted at the user's
 * project tree (up), or `ProjectWriter` rooted at a fresh tempdir (prepare).
 *
 * Out of scope here: refuse-when-dirty preflight, lockfile persistence, exit
 * code policy. Those are caller-specific.
 */
import type { Target, EmittedFile, ComponentSource } from '../types.js';
import { discoverComponents } from '../discover.js';
import { findOutfit } from '../outfit.js';
import { findCut } from '../cut.js';
import { findAccessory } from '../accessory.js';
import { resolve, skillsKeepFromResolution } from '../resolution.js';
import { getAdapter } from '../../adapters/index.js';
import { loadRepoConfig } from '../config.js';
import { isAdditivePath } from '../writer.js';
import { sha256OfBuffer } from '../lockfile.js';
import { isJsonMergeable, mergeJsonBuffers } from '../merge.js';
import { loadGlobalsRegistry } from '../globals-loader.js';

/**
 * One file destined for the dressed project tree (or a tempdir bundle that
 * mirrors it). Carries everything callers need: relative path, raw bytes,
 * unix mode, content sha256, lockfile-removal strategy, and a label for which
 * component emitted it.
 */
export interface PendingFile {
  path: string;
  content: string | Buffer;
  /** Unix file permission mode (octal). */
  mode?: number;
  sha256: string;
  sourceComponent: string;
  /**
   * Lockfile removal strategy. Defaults to 'replace' (suit owns the whole
   * file). 'additive' means the content is a marker-wrapped block that gets
   * appended into possibly-user-authored files (CLAUDE.md), and the recorded
   * sha256 is the BLOCK hash, not the whole-file hash.
   */
  lockMode?: 'replace' | 'additive';
}

/**
 * Per-target prefix applied to adapter-emitted relative paths when writing into
 * a project tree (or a project-shaped tempdir). The build flow (suit-build)
 * emits into `dist/<target>/`, so paths like `skills/foo/SKILL.md` are
 * unambiguous. For the project-shaped destinations these paths need to land in
 * the harness's project location.
 */
export const TARGET_PROJECT_PREFIX: Record<Target, string> = {
  'claude-code': '.claude',
  gemini: '.gemini',
  pi: '', // adapter already emits with `.pi/` prefix
  codex: '',
};

function applyTargetPrefix(target: Target, emittedPath: string): string {
  const prefix = TARGET_PROJECT_PREFIX[target];
  if (!prefix) return emittedPath;
  if (emittedPath === prefix || emittedPath.startsWith(`${prefix}/`)) {
    return emittedPath;
  }
  // Project-root files emitted at the top of the dist tree (CLAUDE.md,
  // GEMINI.md, AGENTS.md, .mcp.fragment.json, etc.)
  // stay put — they're meant to live at the project root.
  if (!emittedPath.includes('/')) return emittedPath;
  return `${prefix}/${emittedPath}`;
}

/**
 * Map an emit-time path (what an adapter produced) to the on-disk path the
 * destination filesystem should hold. Today's only redirects are the Claude
 * Code and Gemini settings fragments → `*.local.json` so the harnesses read
 * them natively. The launcher (TempdirWriter prelaunch) keeps the fragment
 * names because suit-build merges them into a real settings.json before
 * exec'ing the harness.
 */
export function projectPathRedirect(emitPath: string): string {
  if (emitPath === '.claude/settings.fragment.json') return '.claude/settings.local.json';
  if (emitPath === '.gemini/settings.fragment.json') return '.gemini/settings.json';
  return emitPath;
}

/**
 * Render the outfit's body (and any active cut body) into the marker block
 * that goes into CLAUDE.md.
 */
function renderOutfitBlock(
  outfitName: string,
  outfitBody: string,
  cutBody: string | undefined,
  _accessoryCount: number,
): string {
  const parts = [outfitBody.trim()];
  if (cutBody && cutBody.trim().length > 0) {
    parts.push('', cutBody.trim());
  }
  return `<!-- suit:outfit:${outfitName} -->\n${parts.join('\n')}\n<!-- /suit:outfit:${outfitName} -->`;
}

function unionTargets(
  outfitTargets: Target[],
  cutTargets: Target[] | undefined,
  accessoryTargetsList: Target[][],
): Target[] {
  const set = new Set<Target>(outfitTargets);
  if (cutTargets) for (const t of cutTargets) set.add(t);
  for (const list of accessoryTargetsList) for (const t of list) set.add(t);
  return Array.from(set);
}

async function emitForTarget(
  target: Target,
  catalog: ComponentSource[],
  skillsDrop: string[],
  projectDir: string,
  repoConfig: Record<string, Record<string, unknown>>,
): Promise<PendingFile[]> {
  const adapter = getAdapter(target);
  if (!adapter) {
    throw new Error(`compose: no adapter registered for target "${target}"`);
  }
  const dropSet = new Set(skillsDrop);
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
    if (prior.sha256 === f.sha256) continue;

    if (isJsonMergeable(f.path)) {
      const merged = mergeJsonBuffers(prior.content, f.content);
      byPath.set(f.path, {
        path: f.path,
        content: merged,
        sha256: sha256OfBuffer(merged),
        sourceComponent: `${prior.sourceComponent} + ${f.sourceComponent}`,
        mode: prior.mode ?? f.mode,
      });
      continue;
    }

    throw new Error(
      `compose: two emitted files collide at "${f.path}" with different contents ` +
        `(sources: "${prior.sourceComponent}" vs "${f.sourceComponent}")`,
    );
  }
  return Array.from(byPath.values());
}

export interface ComposeBundleArgs {
  outfit: string;
  cut: string | null;
  accessories: string[];
  /** If null/empty, derive targets from the resolved outfit/cut/accessories union. */
  targets?: Target[];
  /** Project root used for repoConfig lookup + resolver context. NOT a write destination. */
  projectDir: string;
  contentDir: string;
  userDir: string;
}

export interface ComposeBundleDeps {
  stderr: (s: string) => void;
}

export interface ComposeBundleResult {
  pending: PendingFile[];
  outfitName: string;
  resolution: { outfit: string; cut: string | null; accessories: string[] };
  targets: Target[];
}

/**
 * Run the full discovery → emit → dedupe → additive-wrap pipeline. Returns the
 * list of files ready to write to a destination of the caller's choosing.
 *
 * If `args.targets` is provided, emit only for those targets (used by `suit
 * prepare` to scope the bundle to one harness). Otherwise emit for the union
 * of all targets the resolved components declare (used by `suit up`).
 */
export async function composeBundle(
  args: ComposeBundleArgs,
  deps: ComposeBundleDeps,
): Promise<ComposeBundleResult> {
  const dirs = {
    projectDir: args.projectDir,
    userDir: args.userDir,
    builtinDir: args.contentDir,
  };

  const foundOutfit = await findOutfit(args.outfit, dirs);
  const outfitManifest = foundOutfit.manifest;

  let cutManifest;
  let cutBody: string | undefined;
  if (args.cut) {
    const found = await findCut(args.cut, dirs);
    cutManifest = found.manifest;
    cutBody = found.body;
  }

  const accessoryManifests = [];
  for (const accName of args.accessories) {
    const found = await findAccessory(accName, dirs);
    accessoryManifests.push(found.manifest);
  }

  const catalog = await discoverComponents(args.contentDir);

  const derivedTargets = unionTargets(
    outfitManifest.targets,
    cutManifest?.targets,
    accessoryManifests.map((a) => a.targets),
  );
  const targets = args.targets && args.targets.length > 0 ? args.targets : derivedTargets;

  let globals = null;
  try {
    globals = await loadGlobalsRegistry(args.contentDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`compose: failed to load globals.yaml: ${msg}`);
  }

  const canonicalResolution = resolve({
    catalog,
    outfit: outfitManifest,
    cut: cutManifest,
    accessories: accessoryManifests,
    cutBody,
    harness: targets[0],
    globals,
    warn: (msg) => deps.stderr(`${msg}\n`),
  });

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

  for (const f of pending) {
    f.path = projectPathRedirect(f.path);
  }

  // Inject outfit body as additive .claude/CLAUDE.md (claude-code only).
  if (targets.includes('claude-code') && foundOutfit.body.trim().length > 0) {
    const blockContent = renderOutfitBlock(
      args.outfit,
      foundOutfit.body,
      cutBody,
      accessoryManifests.length,
    );
    pending.push({
      path: '.claude/CLAUDE.md',
      content: blockContent,
      sha256: sha256OfBuffer(blockContent),
      sourceComponent: `outfits/${args.outfit}`,
      lockMode: 'additive',
    });
  }

  // Marker-wrap any pending file at an additive path that isn't already
  // marker-wrapped (#38 Bug B). See up.ts §Stage 5b for the full rationale.
  const additiveAlready = new Set(
    pending.filter((f) => f.lockMode === 'additive').map((f) => f.path),
  );
  for (const f of pending) {
    if (f.lockMode === 'additive') continue;
    if (!isAdditivePath(f.path)) continue;
    if (additiveAlready.has(f.path)) continue;
    const body = typeof f.content === 'string' ? f.content : f.content.toString('utf8');
    const trimmed = body.trim();
    if (trimmed.length === 0) continue;
    const wrapped = `<!-- suit:outfit:${args.outfit} -->\n${trimmed}\n<!-- /suit:outfit:${args.outfit} -->`;
    f.content = wrapped;
    f.lockMode = 'additive';
    f.sha256 = sha256OfBuffer(wrapped);
  }

  // Suppress unused warning — skillsKeep is reserved for a future report that
  // shows which skills were kept vs dropped by the resolver.
  void skillsKeepFromResolution;

  return {
    pending,
    outfitName: args.outfit,
    resolution: {
      outfit: outfitManifest.name,
      cut: cutManifest?.name ?? null,
      accessories: accessoryManifests.map((a) => a.name),
    },
    targets,
  };
}

/**
 * Count files emitted per target, by inspecting their final paths. Best-effort:
 * an unprefixed target gets credited for every unprefixed file emitted at the
 * project root (e.g. AGENTS.md from codex). The lockfile is the source of
 * truth — this counter is for operator diagnostics only.
 */
export function countFilesByTarget(
  pending: PendingFile[],
  targets: Target[],
): Map<Target, number> {
  const filesByTarget = new Map<Target, number>();
  for (const target of targets) {
    const prefix = TARGET_PROJECT_PREFIX[target];
    let count = 0;
    for (const f of pending) {
      if (prefix && (f.path === prefix || f.path.startsWith(`${prefix}/`))) count++;
      else if (!prefix) count++;
    }
    filesByTarget.set(target, count);
  }
  return filesByTarget;
}

