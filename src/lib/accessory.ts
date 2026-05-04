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

export async function findAccessory(
  name: string,
  dirs: DiscoveryDirs,
): Promise<FoundAccessory> {
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
          };
        }
      }
    }
  }
  throw new Error(
    `accessory not found: "${name}". Available: ${seen.length === 0 ? '(none)' : seen.join(', ')}`,
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
          });
        }
      }
    }
  }
  return Array.from(found.values()).sort((a, b) =>
    a.manifest.name.localeCompare(b.manifest.name),
  );
}
