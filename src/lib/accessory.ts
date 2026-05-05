import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { AccessorySchema, type AccessoryManifest } from './schema.js';
import type { DiscoveryDirs } from './outfit.js';

export type { DiscoveryDirs } from './outfit.js';

export interface FoundAccessory {
  manifest: AccessoryManifest;
  body: string;
  source: 'project' | 'user' | 'builtin';
  filepath: string;
  /**
   * True when this FoundAccessory is a synthetic one-component bundle
   * synthesized from a non-accessory component (skill/hook/rule/agent/command)
   * via the v0.6 accessory-as-role fall-through. Real accessory bundles
   * authored under `accessories/` set this to false.
   */
  synthetic: boolean;
}

const TIERS: Array<keyof DiscoveryDirs> = ['projectDir', 'userDir', 'builtinDir'];
const TIER_NAMES: Record<keyof DiscoveryDirs, FoundAccessory['source']> = {
  projectDir: 'project',
  userDir: 'user',
  builtinDir: 'builtin',
};

function resolveTierRoots(tier: keyof DiscoveryDirs, dirs: DiscoveryDirs): string[] {
  switch (tier) {
    case 'projectDir':
      return [path.join(dirs.projectDir, '.suit', 'accessories')];
    case 'userDir':
      return [path.join(dirs.userDir, 'accessories')];
    case 'builtinDir':
      return [path.join(dirs.builtinDir, 'accessories')];
  }
}

/**
 * v0.6 accessory-as-role fall-through. When `--accessory <name>` doesn't match
 * an authored bundle under `accessories/`, suit falls through and searches
 * the wardrobe's other component dirs in this order: skills → hooks → rules
 * → agents → commands. The first match is returned wrapped as a synthetic
 * AccessoryManifest whose include block contains a single-element array for
 * the matching field. This eliminates 1-skill wrapper-accessory boilerplate.
 */
type FallthroughKind = 'skill' | 'hook' | 'rule' | 'agent' | 'command';

interface FallthroughDef {
  kind: FallthroughKind;
  /** dirname under each tier root (e.g. "skills") */
  topDir: string;
  /** include-block field this kind populates */
  includeField: 'skills' | 'hooks' | 'rules' | 'agents' | 'commands';
  /** filenames to look for inside <topDir>/<componentDir>/ */
  filenames: string[];
}

const FALLTHROUGHS: FallthroughDef[] = [
  { kind: 'skill', topDir: 'skills', includeField: 'skills', filenames: ['SKILL.md'] },
  { kind: 'hook', topDir: 'hooks', includeField: 'hooks', filenames: ['HOOK.md', 'SKILL.md'] },
  // Wardrobe convention is `RULE.md` (singular), matching SKILL.md / HOOK.md /
  // AGENT.md / COMMAND.md. The schema's `type` literal is plural (`'rules'`)
  // but the file convention is singular. Accept both forms for safety.
  { kind: 'rule', topDir: 'rules', includeField: 'rules', filenames: ['RULE.md', 'RULES.md', 'SKILL.md'] },
  { kind: 'agent', topDir: 'agents', includeField: 'agents', filenames: ['AGENT.md', 'SKILL.md'] },
  { kind: 'command', topDir: 'commands', includeField: 'commands', filenames: ['COMMAND.md', 'SKILL.md'] },
];

function fallthroughTierRoots(
  tier: keyof DiscoveryDirs,
  dirs: DiscoveryDirs,
  topDir: string,
): string[] {
  switch (tier) {
    case 'projectDir':
      return [path.join(dirs.projectDir, '.suit', topDir)];
    case 'userDir':
      return [path.join(dirs.userDir, topDir)];
    case 'builtinDir':
      return [path.join(dirs.builtinDir, topDir)];
  }
}

async function listAccessoryFilenames(dir: string): Promise<string[]> {
  // The 3 tiers each store accessories slightly differently:
  //   projectDir: <projectDir>/.suit/accessories/<name>.md
  //   userDir:    <userDir>/accessories/<name>.md
  //   builtinDir: <builtinDir>/accessories/<name>/accessory.md
  // Mirror outfit.ts: glob *.md and dirs containing accessory.md.
  const out: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) out.push(path.join(dir, e.name));
      else if (e.isDirectory()) {
        const candidate = path.join(dir, e.name, 'accessory.md');
        try {
          await fs.access(candidate);
          out.push(candidate);
        } catch {
          // not an accessory dir
        }
      }
    }
  } catch {
    // dir doesn't exist
  }
  return out;
}

/**
 * Search a fall-through component dir (skills/, hooks/, rules/, agents/,
 * commands/) under one tier root for a component manifest matching `name`.
 * Returns the parsed manifest data + the filepath, or null if not found in
 * this root.
 *
 * Uses a permissive parse (the manifest base) rather than a strict
 * type-narrowed schema because individual component schemas vary widely; we
 * only need name/version/targets to synthesize the wrapper. Discover validates
 * each component's full manifest at catalog-build time, so anything we find
 * here is already known to satisfy its own schema.
 */
async function findFallthroughComponent(
  root: string,
  name: string,
  filenames: string[],
): Promise<{ manifest: any; body: string; filepath: string } | null> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== name) continue; // dir name must match component name
    const componentDir = path.join(root, entry.name);
    for (const fname of filenames) {
      const candidate = path.join(componentDir, fname);
      let raw: string;
      try {
        raw = await fs.readFile(candidate, 'utf8');
      } catch {
        continue;
      }
      const parsed = matter(raw);
      const data: any = parsed.data ?? {};
      // Confirm the manifest's name field also matches — guards against a
      // dir-name/manifest-name mismatch (validate.ts catches this elsewhere
      // but we should be defensive at the resolution boundary too).
      if (data.name !== name) continue;
      return { manifest: data, body: parsed.content, filepath: candidate };
    }
  }
  return null;
}

function synthesizeAccessoryManifest(
  componentName: string,
  componentVersion: string,
  componentTargets: string[],
  kind: FallthroughKind,
  includeField: FallthroughDef['includeField'],
): AccessoryManifest {
  const include = {
    skills: [] as string[],
    rules: [] as string[],
    hooks: [] as string[],
    agents: [] as string[],
    commands: [] as string[],
  };
  include[includeField] = [componentName];
  return {
    name: componentName,
    version: componentVersion,
    type: 'accessory' as const,
    description: `(synthetic accessory wrapping ${kind} "${componentName}")`,
    targets: componentTargets as AccessoryManifest['targets'],
    categories: [],
    include,
    // v0.7+: synthetic accessories never enable/disable globals.
    enable: { plugins: [], mcps: [], hooks: [] },
    disable: { plugins: [], mcps: [], hooks: [] },
  } as AccessoryManifest;
}

export async function findAccessory(
  name: string,
  dirs: DiscoveryDirs,
): Promise<FoundAccessory> {
  // Phase 1: search authored accessory bundles across all 3 tiers.
  const seen: string[] = [];
  for (const tier of TIERS) {
    for (const root of resolveTierRoots(tier, dirs)) {
      const files = await listAccessoryFilenames(root);
      for (const filepath of files) {
        const raw = await fs.readFile(filepath, 'utf8');
        const parsed = matter(raw);
        const result = AccessorySchema.safeParse(parsed.data);
        if (!result.success) continue; // skip invalid; validate.ts catches them at build
        seen.push(result.data.name);
        if (result.data.name === name) {
          return {
            manifest: result.data,
            body: parsed.content,
            source: TIER_NAMES[tier],
            filepath,
            synthetic: false,
          };
        }
      }
    }
  }

  // Phase 2: accessory-as-role fall-through. Search skills, hooks, rules,
  // agents, commands across the same 3 tiers in that order. First match wins
  // and is returned as a synthetic wrapper accessory.
  for (const ft of FALLTHROUGHS) {
    for (const tier of TIERS) {
      for (const root of fallthroughTierRoots(tier, dirs, ft.topDir)) {
        const hit = await findFallthroughComponent(root, name, ft.filenames);
        if (!hit) continue;
        const m = hit.manifest;
        // Defensive defaults — discover.ts validates these strictly, but for
        // synthesis we only need them to be plausible.
        const version = typeof m.version === 'string' ? m.version : '0.0.0';
        const targets = Array.isArray(m.targets) ? m.targets : ['claude-code'];
        const manifest = synthesizeAccessoryManifest(
          name,
          version,
          targets,
          ft.kind,
          ft.includeField,
        );
        return {
          manifest,
          body: hit.body,
          source: TIER_NAMES[tier],
          filepath: hit.filepath,
          synthetic: true,
        };
      }
    }
  }

  throw new Error(
    `accessory/skill/hook/rule/agent/command not found: "${name}". Available accessories: ${seen.length === 0 ? '(none)' : seen.join(', ')}`,
  );
}

export async function listAllAccessories(dirs: DiscoveryDirs): Promise<FoundAccessory[]> {
  const found = new Map<string, FoundAccessory>();
  for (const tier of TIERS) {
    for (const root of resolveTierRoots(tier, dirs)) {
      const files = await listAccessoryFilenames(root);
      for (const filepath of files) {
        const raw = await fs.readFile(filepath, 'utf8');
        const parsed = matter(raw);
        const result = AccessorySchema.safeParse(parsed.data);
        if (!result.success) continue;
        // Higher-priority tier (and earlier path within tier) already won; don't overwrite.
        if (!found.has(result.data.name)) {
          found.set(result.data.name, {
            manifest: result.data,
            body: parsed.content,
            source: TIER_NAMES[tier],
            filepath,
            synthetic: false,
          });
        }
      }
    }
  }
  return Array.from(found.values()).sort((a, b) =>
    a.manifest.name.localeCompare(b.manifest.name),
  );
}
