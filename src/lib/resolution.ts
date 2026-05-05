import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ComponentSource, Target } from './types.js';
import type { OutfitManifest, CutManifest, AccessoryManifest, EnableDisableBlock } from './schema.js';
import type { GlobalsRegistry } from './globals-schema.js';
import { entryHarness } from './globals-schema.js';
import { loadHarnessCatalog } from './ac/harness-catalog.js';

export interface GlobalsResolutionMetadata {
  plugins: { kept: string[]; dropped: string[]; unresolved: string[] };
  mcps: { kept: string[]; dropped: string[]; unresolved: string[] };
  hooks: { kept: string[]; dropped: string[]; unresolved: string[] };
}

export interface Resolution {
  schemaVersion: 1;
  harness: Target;
  skillsDrop: string[];
  skillsKeep: string[] | null;
  cutPrompt: string;
  metadata: {
    outfit: string | null;
    cut: string | null;
    accessories: string[];
    categories: string[];
    globals: GlobalsResolutionMetadata;
  };
}

export interface ResolveOptions {
  catalog: ComponentSource[];
  outfit?: OutfitManifest;
  cut?: CutManifest;
  accessories?: AccessoryManifest[];
  /** Cut body string (the markdown body of the cut component, used as prompt scaffolding). */
  cutBody?: string;
  harness: Target;
  /**
   * v0.7+: per-machine globals registry. When provided, `enable:` / `disable:`
   * blocks on the active outfit/cut/accessories layer over this baseline to
   * compute kept-sets for plugins, mcps, and hooks. When `null` or omitted, no
   * globals filtering is applied — `metadata.globals` is empty.
   */
  globals?: GlobalsRegistry | null;
  /** Optional sink for warnings (e.g. unresolved enable references). */
  warn?: (msg: string) => void;
}

/**
 * Shape shared by cut and accessory include blocks. We accept any object that
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
 * `speaker` is the noun used in the error message — `cut "X" includes ...` vs
 * `accessory "X" includes ...` — so a cut-include miss reads
 * differently from an accessory-include miss without forking the validator.
 */
function validateIncludes(
  speaker: 'cut' | 'accessory',
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

/**
 * Empty globals metadata block — emitted when no globals registry is supplied.
 * Kept as a function (not a const) so each call site gets its own arrays and
 * downstream mutation can't leak between resolutions.
 */
function emptyGlobalsMetadata(): GlobalsResolutionMetadata {
  return {
    plugins: { kept: [], dropped: [], unresolved: [] },
    mcps: { kept: [], dropped: [], unresolved: [] },
    hooks: { kept: [], dropped: [], unresolved: [] },
  };
}

/**
 * Layer per-kind enable/disable directives over a baseline kept-set.
 *
 * Semantics (ADR-0014 Phase D):
 *   1. Baseline = full set of registered names from globals.<kind>.
 *   2. For each layer in CLI declaration order (outfit, cut, then accessories
 *      in array order), apply `disable` first, then `enable`.
 *   3. `disable` removes names from the kept set. Disabling something that's
 *      already absent is a silent no-op (idempotent).
 *   4. `enable` re-adds names. If the name isn't in the globals registry, it's
 *      tracked as `unresolved` and a warning is emitted; we DON'T add unknown
 *      names to the kept set since downstream code (symlink-farm, mcpServers
 *      rewrite) needs every kept name to correspond to a real registry entry.
 */
function resolveGlobalsKind(
  kind: 'plugins' | 'mcps' | 'hooks',
  registry: GlobalsRegistry,
  layers: Array<{ ownerLabel: string; block: { enable: EnableDisableBlock; disable: EnableDisableBlock } }>,
  warn: (msg: string) => void,
  /**
   * v0.8: when set, baseline + kept-set is restricted to entries whose
   * harness matches. `undefined` (legacy) means all entries participate —
   * preserves v0.7 semantics.
   */
  harnessFilter?: 'claude-code' | 'codex',
): { kept: string[]; dropped: string[]; unresolved: string[] } {
  const allEntries = registry[kind] as Record<string, { harness?: 'claude-code' | 'codex' }>;
  // hooks entries don't carry a harness today; treat them as claude-code.
  const baselineNames =
    harnessFilter === undefined
      ? Object.keys(allEntries)
      : Object.entries(allEntries)
          .filter(([, e]) => entryHarness(e) === harnessFilter)
          .map(([k]) => k);
  const baseline = new Set(baselineNames);
  const kept = new Set(baseline);
  const unresolved: string[] = [];
  const seenUnresolved = new Set<string>();

  for (const layer of layers) {
    const block = layer.block;
    for (const name of block.disable[kind] ?? []) {
      kept.delete(name);
    }
    for (const name of block.enable[kind] ?? []) {
      if (!baseline.has(name)) {
        // When harness filtering is active, an `enable` reference to an entry
        // belonging to the OTHER harness isn't really "unresolved" — it just
        // doesn't apply to this session. We silently skip those (no warning,
        // not tracked) so a single outfit can carry enable lists for both
        // harnesses without spamming warnings on every launch.
        if (
          harnessFilter !== undefined &&
          allEntries[name] !== undefined &&
          entryHarness(allEntries[name]!) !== harnessFilter
        ) {
          continue;
        }
        if (!seenUnresolved.has(name)) {
          unresolved.push(name);
          seenUnresolved.add(name);
          warn(
            `globals: ${layer.ownerLabel} enable.${kind} references "${name}" not in globals.yaml — ignoring`,
          );
        }
        continue;
      }
      kept.add(name);
    }
  }

  const dropped: string[] = [];
  for (const name of baseline) {
    if (!kept.has(name)) dropped.push(name);
  }
  return {
    kept: Array.from(kept).sort(),
    dropped: dropped.sort(),
    unresolved,
  };
}

/**
 * Composing manifests — the three primitives that participate in the
 * outfit/cut/accessory layering. Each carries `enable` and `disable` blocks per
 * ADR-0014. Skills, hooks, rules, agents, commands, plugins, and mcps don't
 * compose at this level so they're excluded.
 */
type ComposingManifest = OutfitManifest | CutManifest | AccessoryManifest;

interface GlobalsLayer {
  ownerLabel: string;
  block: { enable: EnableDisableBlock; disable: EnableDisableBlock };
}

/**
 * Wrap a composing manifest into a layer for `resolveGlobalsKind`. Defensive
 * `??` defaults guard test fixtures that construct partial manifests via `as
 * any` — at runtime the parsed schemas fill enable/disable, but the test
 * fixture pattern predates that field.
 */
function makeGlobalsLayer(label: string, m: ComposingManifest): GlobalsLayer {
  return {
    ownerLabel: label,
    block: {
      enable: m.enable ?? { plugins: [], mcps: [], hooks: [] },
      disable: m.disable ?? { plugins: [], mcps: [], hooks: [] },
    },
  };
}

/**
 * Compute kept/dropped/unresolved metadata for plugins, mcps, and hooks against
 * the active harness. Returns the all-empty shape for harnesses that don't
 * participate in globals filtering today (gemini, copilot, apm, pi).
 */
function computeGlobalsMetadata(
  globals: GlobalsRegistry,
  outfit: OutfitManifest | undefined,
  cut: CutManifest | undefined,
  accessories: AccessoryManifest[],
  harness: Target,
  warn: (msg: string) => void,
): GlobalsResolutionMetadata {
  const harnessFilter: 'claude-code' | 'codex' | undefined =
    harness === 'claude-code' ? 'claude-code' : harness === 'codex' ? 'codex' : undefined;
  if (harnessFilter === undefined) return emptyGlobalsMetadata();

  const layers: GlobalsLayer[] = [];
  if (outfit) layers.push(makeGlobalsLayer(`outfit "${outfit.name}"`, outfit));
  if (cut) layers.push(makeGlobalsLayer(`cut "${cut.name}"`, cut));
  for (const acc of accessories) {
    layers.push(makeGlobalsLayer(`accessory "${acc.name}"`, acc));
  }

  return {
    plugins: resolveGlobalsKind('plugins', globals, layers, warn, harnessFilter),
    mcps: resolveGlobalsKind('mcps', globals, layers, warn, harnessFilter),
    hooks: resolveGlobalsKind('hooks', globals, layers, warn, harnessFilter),
  };
}

/**
 * Compute the effective category set: intersection when both outfit and cut
 * declare categories, single set when only one does, null when neither.
 */
function computeEffectiveCategories(
  outfit: OutfitManifest | undefined,
  cut: CutManifest | undefined,
): Set<string> | null {
  if (outfit && cut) {
    const p = new Set(outfit.categories);
    return new Set(cut.categories.filter((c) => p.has(c)));
  }
  if (outfit) return new Set(outfit.categories);
  if (cut) return new Set(cut.categories);
  return null;
}

/**
 * Compute the initial skillsDrop list via category filtering. Forced excludes
 * win first; forced includes rescue specific names; uncategorized skills always
 * load; otherwise drop unless the skill's primary category intersects the
 * effective categories set.
 */
function computeSkillsDrop(
  catalog: ComponentSource[],
  outfit: OutfitManifest | undefined,
  cut: CutManifest | undefined,
  effectiveCategories: Set<string> | null,
): string[] {
  const includeNames = new Set([
    ...(outfit?.skill_include ?? []),
    ...(cut?.skill_include ?? []),
  ]);
  const excludeNames = new Set([
    ...(outfit?.skill_exclude ?? []),
    ...(cut?.skill_exclude ?? []),
  ]);

  const skillsDrop: string[] = [];
  for (const c of catalog) {
    if (c.manifest.type !== 'skill') continue;
    const skillCategory = c.manifest.category?.primary;

    if (excludeNames.has(c.manifest.name)) {
      skillsDrop.push(c.manifest.name);
      continue;
    }
    if (includeNames.has(c.manifest.name)) continue;
    if (skillCategory === undefined) continue;
    if (!effectiveCategories) continue;
    if (effectiveCategories.has(skillCategory)) continue;
    skillsDrop.push(c.manifest.name);
  }
  return skillsDrop;
}

/**
 * Force-include phase per ADR-0010 §3. Layer overlays AFTER outfit + cut
 * category filtering and reverse the outfit's category-based drops. Order:
 *
 *   1. cut.include (if the active cut declares one) — runs first so a
 *      cut-bundled component is in the kept set before any accessory layers
 *      its own bundle on top.
 *   2. each accessory's include in CLI order.
 *
 * Convergence: every named skill is removed from the drop set, and once
 * removed it stays removed regardless of who runs next. Order matters only for
 * "first to add" claim logging; the resulting kept-set is identical.
 *
 * Defensive: callers may construct CutManifest-shaped objects via `as any`
 * (existing tests do) so `cut.include` may be undefined at runtime even though
 * the schema fills it in for parsed manifests. Treat undefined as the empty
 * default so back-compat callers continue to skip the force-include phase.
 */
function applyForceIncludes(
  skillsDrop: string[],
  cut: CutManifest | undefined,
  accessories: AccessoryManifest[],
): string[] {
  const cutInclude = cut?.include;
  const hasCutIncludes = cutInclude
    ? cutInclude.skills.length +
        cutInclude.rules.length +
        cutInclude.hooks.length +
        cutInclude.agents.length +
        cutInclude.commands.length >
      0
    : false;
  if (!hasCutIncludes && accessories.length === 0) {
    return skillsDrop;
  }
  const dropSet = new Set(skillsDrop);
  if (cutInclude && hasCutIncludes) {
    for (const skillName of cutInclude.skills) {
      dropSet.delete(skillName);
    }
  }
  for (const acc of accessories) {
    for (const skillName of acc.include.skills) {
      dropSet.delete(skillName);
    }
  }
  return Array.from(dropSet);
}

export function resolve(opts: ResolveOptions): Resolution {
  const { catalog, outfit, cut, cutBody, harness } = opts;
  const accessories = opts.accessories ?? [];
  const warn = opts.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  // Phase 1: validate include blocks (strict per ADR-0010). Cut first so a
  // cut typo surfaces before any accessory-level error.
  if (cut?.include) {
    validateIncludes('cut', cut.name, cut.include, catalog);
  }
  for (const acc of accessories) {
    validateIncludes('accessory', acc.name, acc.include, catalog);
  }

  // Phase 2: globals kept/dropped/unresolved sets per kind. Skipped entirely
  // when no registry is supplied to preserve v0.6 behavior.
  const globalsMetadata = opts.globals
    ? computeGlobalsMetadata(opts.globals, outfit, cut, accessories, harness, warn)
    : emptyGlobalsMetadata();

  // Phase 3: identity short-circuit when no composition primitives are active.
  if (!outfit && !cut && accessories.length === 0) {
    return {
      schemaVersion: 1,
      harness,
      skillsDrop: [],
      skillsKeep: null,
      cutPrompt: '',
      metadata: {
        outfit: null,
        cut: null,
        accessories: [],
        categories: [],
        globals: globalsMetadata,
      },
    };
  }

  // Phase 4-6: category filter, force-include rescue, assemble.
  const effectiveCategories = computeEffectiveCategories(outfit, cut);
  const initialDrops = computeSkillsDrop(catalog, outfit, cut, effectiveCategories);
  const skillsDrop = applyForceIncludes(initialDrops, cut, accessories);

  return {
    schemaVersion: 1,
    harness,
    skillsDrop,
    skillsKeep: null,
    cutPrompt: cutBody ?? '',
    metadata: {
      outfit: outfit?.name ?? null,
      cut: cut?.name ?? null,
      accessories: accessories.map((a) => a.name),
      categories: effectiveCategories ? Array.from(effectiveCategories) : [],
      globals: globalsMetadata,
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
  cut?: CutManifest;
  accessories?: AccessoryManifest[];
  cutBody?: string;
  globals?: GlobalsRegistry | null;
  warn?: (msg: string) => void;
}

export async function resolveAgainstHarness(
  opts: ResolveAgainstHarnessOptions,
): Promise<Resolution> {
  const catalog = await loadHarnessCatalog(opts.target, opts.harnessHome);
  return resolve({
    catalog,
    outfit: opts.outfit,
    cut: opts.cut,
    accessories: opts.accessories,
    cutBody: opts.cutBody,
    harness: opts.target,
    globals: opts.globals,
    warn: opts.warn,
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
