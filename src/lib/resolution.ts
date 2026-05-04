import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ComponentSource, Target } from './types.js';
import type { OutfitManifest, ModeManifest } from './schema.js';
import { loadHarnessCatalog } from './ac/harness-catalog.js';

export interface Resolution {
  schemaVersion: 1;
  harness: Target;
  skillsDrop: string[];
  skillsKeep: string[] | null;
  modePrompt: string;
  metadata: {
    outfit: string | null;
    mode: string | null;
    categories: string[];
  };
}

export interface ResolveOptions {
  catalog: ComponentSource[];
  outfit?: OutfitManifest;
  mode?: ModeManifest;
  /** Mode body string (the markdown body of the mode component, used as prompt scaffolding). */
  modeBody?: string;
  harness: Target;
}

export function resolve(opts: ResolveOptions): Resolution {
  const { catalog, outfit, mode, modeBody, harness } = opts;

  // No outfit, no mode → identity (no filter).
  if (!outfit && !mode) {
    return {
      schemaVersion: 1,
      harness,
      skillsDrop: [],
      skillsKeep: null,
      modePrompt: '',
      metadata: { outfit: null, mode: null, categories: [] },
    };
  }

  // Effective categories: intersection if both, single if one.
  let effectiveCategories: Set<string> | null = null;
  if (outfit && mode) {
    const p = new Set(outfit.categories);
    effectiveCategories = new Set(mode.categories.filter((c) => p.has(c)));
  } else if (outfit) {
    effectiveCategories = new Set(outfit.categories);
  } else if (mode) {
    effectiveCategories = new Set(mode.categories);
  }

  const includeNames = new Set([
    ...(outfit?.skill_include ?? []),
    ...(mode?.skill_include ?? []),
  ]);
  const excludeNames = new Set([
    ...(outfit?.skill_exclude ?? []),
    ...(mode?.skill_exclude ?? []),
  ]);

  const skillsDrop: string[] = [];
  for (const c of catalog) {
    if (c.manifest.type !== 'skill') continue;
    const skillCategory = (c.manifest as any).category?.primary as string | undefined;

    // Forced exclude wins.
    if (excludeNames.has(c.manifest.name)) {
      skillsDrop.push(c.manifest.name);
      continue;
    }
    // Forced include wins over category mismatch.
    if (includeNames.has(c.manifest.name)) continue;
    // Universal default — uncategorized skills always load.
    if (skillCategory === undefined) continue;
    // Category match.
    if (effectiveCategories && effectiveCategories.has(skillCategory)) continue;
    // Otherwise: drop.
    skillsDrop.push(c.manifest.name);
  }

  return {
    schemaVersion: 1,
    harness,
    skillsDrop,
    skillsKeep: null,
    modePrompt: modeBody ?? '',
    metadata: {
      outfit: outfit?.name ?? null,
      mode: mode?.name ?? null,
      categories: effectiveCategories ? Array.from(effectiveCategories) : [],
    },
  };
}

export async function writeResolutionArtifact(r: Resolution): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-sess-'));
  const filepath = path.join(dir, 'resolution.json');
  await fs.writeFile(filepath, JSON.stringify(r, null, 2) + '\n');
  return filepath;
}

/**
 * Resolve and persist in one call. Use this when a caller needs both the
 * in-memory resolution and an on-disk artifact path (e.g. AC harness flows
 * that hand the path to a child process via env). Pure callers — including
 * `resolveAgainstHarness` and the prelaunch composition path — keep using
 * `resolve()` directly to avoid the unnecessary tmpdir write.
 */
export async function resolveAndPersist(
  opts: ResolveOptions,
): Promise<{ resolution: Resolution; artifactPath: string }> {
  const resolution = resolve(opts);
  const artifactPath = await writeResolutionArtifact(resolution);
  return { resolution, artifactPath };
}

export interface ResolveAgainstHarnessOptions {
  target: Target;
  harnessHome: string;
  outfit?: OutfitManifest;
  mode?: ModeManifest;
  modeBody?: string;
}

export async function resolveAgainstHarness(
  opts: ResolveAgainstHarnessOptions,
): Promise<Resolution> {
  const catalog = await loadHarnessCatalog(opts.target, opts.harnessHome);
  return resolve({
    catalog,
    outfit: opts.outfit,
    mode: opts.mode,
    modeBody: opts.modeBody,
    harness: opts.target,
  });
}

export function skillsKeepFromResolution(
  catalog: ComponentSource[],
  drop: string[],
): string[] {
  const dropSet = new Set(drop);
  return catalog
    .filter((c) => c.manifest.type === 'skill')
    .map((c) => c.manifest.name)
    .filter((n) => !dropSet.has(n));
}
