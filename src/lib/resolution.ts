import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ComponentSource, Target } from './types.js';
import type { OutfitManifest, ModeManifest, AccessoryManifest } from './schema.js';
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
    accessories: string[];
    categories: string[];
  };
}

export interface ResolveOptions {
  catalog: ComponentSource[];
  outfit?: OutfitManifest;
  mode?: ModeManifest;
  accessories?: AccessoryManifest[];
  /** Mode body string (the markdown body of the mode component, used as prompt scaffolding). */
  modeBody?: string;
  harness: Target;
}

/**
 * Shape shared by mode and accessory include blocks. We accept any object that
 * exposes the 5 sub-arrays; the strict shape is enforced by the schemas at
 * parse time, so this internal type just gives `validateIncludes` a uniform
 * input.
 */
type IncludeBlock = {
  skills: string[];
  rules: string[];
  hooks: string[];
  agents: string[];
  commands: string[];
};

/**
 * Validate every component name referenced by an `include` block against the
 * discovered catalog. Throws a precise per-name error on the first miss so
 * authors know which entry needs fixing.
 *
 * Component-type → catalog manifest type map:
 *   skills    → 'skill'
 *   rules     → 'rules'
 *   hooks     → 'hook'
 *   agents    → 'agent'
 *   commands  → (no first-class type today; treated as no-op for validation)
 *
 * Validation is strict-by-default per ADR-0010: a missing reference fails
 * resolution rather than silently dropping. The exception is `commands`: there
 * is no `command` component type in the v0.3 schema, so we cannot validate
 * those names here. A future commands ADR will tighten this.
 *
 * `speaker` is the noun used in the error message — `mode "X" includes ...` vs
 * `accessory "X" includes ...` — so a Phase 3 mode-include miss reads
 * differently from an accessory-include miss without forking the validator.
 */
function validateIncludes(
  speaker: 'mode' | 'accessory',
  ownerName: string,
  inc: IncludeBlock,
  catalog: ComponentSource[],
): void {
  const checks: Array<{
    field: 'skills' | 'rules' | 'hooks' | 'agents';
    singular: 'skill' | 'rule' | 'hook' | 'agent';
    componentType: 'skill' | 'rules' | 'hook' | 'agent';
  }> = [
    { field: 'skills', singular: 'skill', componentType: 'skill' },
    { field: 'rules', singular: 'rule', componentType: 'rules' },
    { field: 'hooks', singular: 'hook', componentType: 'hook' },
    { field: 'agents', singular: 'agent', componentType: 'agent' },
  ];
  for (const { field, singular, componentType } of checks) {
    const refs = inc[field] ?? [];
    for (const refName of refs) {
      const found = catalog.find(
        (c) => c.manifest.type === componentType && c.manifest.name === refName,
      );
      if (!found) {
        throw new Error(
          `${speaker} "${ownerName}" includes ${singular} "${refName}" not found in wardrobe`,
        );
      }
    }
  }
  // `commands` has no first-class type yet; we accept any reference. When a
  // dedicated command component type lands, fold it into the loop above.
}

export function resolve(opts: ResolveOptions): Resolution {
  const { catalog, outfit, mode, modeBody, harness } = opts;
  const accessories = opts.accessories ?? [];

  // Validate every include block up front. Strict-include semantics per
  // ADR-0010: bad references fail resolution rather than silently emit a
  // partially-applied session. Mode include is validated with speaker="mode"
  // so its error message reads `mode "X" includes ...`; accessories use
  // speaker="accessory". We validate mode first so a typo in the mode is
  // surfaced before any accessory-level error.
  if (mode && mode.include) {
    validateIncludes('mode', mode.name, mode.include, catalog);
  }
  for (const acc of accessories) {
    validateIncludes('accessory', acc.name, acc.include, catalog);
  }

  // No outfit, no mode, no accessories → identity (no filter).
  if (!outfit && !mode && accessories.length === 0) {
    return {
      schemaVersion: 1,
      harness,
      skillsDrop: [],
      skillsKeep: null,
      modePrompt: '',
      metadata: { outfit: null, mode: null, accessories: [], categories: [] },
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
    // No outfit/mode but accessories present → no category filtering at all.
    if (!effectiveCategories) continue;
    // Category match.
    if (effectiveCategories.has(skillCategory)) continue;
    // Otherwise: drop.
    skillsDrop.push(c.manifest.name);
  }

  // Force-include phase per ADR-0010 §3: layer overlays AFTER outfit + mode
  // category filtering and reverse the outfit's category-based drops. Order:
  //
  //   1. mode.include (if the active mode declares one) — runs first so a
  //      mode-bundled component is in the kept set before any accessory layers
  //      its own bundle on top.
  //   2. each accessory's include in CLI order.
  //
  // For pure force-include semantics this ordering is purely cosmetic: every
  // named skill is `delete`d from `dropSet`, and once it's out it stays out
  // regardless of who runs next. The order DOES matter if both a mode and an
  // accessory list the same skill — mode wins the "first to add" claim, the
  // accessory becomes a no-op, but the resulting kept-set is identical. Tests
  // assert this convergence to lock the contract.
  // Defensive: callers may construct ModeManifest-shaped objects via `as any`
  // (existing tests do) so `mode.include` may be undefined at runtime even
  // though the schema fills it in for parsed manifests. Treat undefined as the
  // empty default so back-compat callers continue to skip the force-include
  // phase entirely.
  const modeInclude = mode?.include;
  const hasModeIncludes = modeInclude
    ? modeInclude.skills.length +
        modeInclude.rules.length +
        modeInclude.hooks.length +
        modeInclude.agents.length +
        modeInclude.commands.length >
      0
    : false;
  if (hasModeIncludes || accessories.length > 0) {
    const dropSet = new Set(skillsDrop);
    if (modeInclude && hasModeIncludes) {
      for (const skillName of modeInclude.skills) {
        dropSet.delete(skillName);
      }
    }
    for (const acc of accessories) {
      for (const skillName of acc.include.skills) {
        dropSet.delete(skillName);
      }
    }
    skillsDrop.length = 0;
    skillsDrop.push(...dropSet);
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
      accessories: accessories.map((a) => a.name),
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
  accessories?: AccessoryManifest[];
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
    accessories: opts.accessories,
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
