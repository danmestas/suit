import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { CutSchema, type CutManifest } from './schema.js';
import type { DiscoveryDirs } from './outfit.js';

export interface FoundCut {
  manifest: CutManifest;
  body: string;
  source: 'project' | 'user' | 'builtin';
  filepath: string;
}

const TIERS: Array<keyof DiscoveryDirs> = ['projectDir', 'userDir', 'builtinDir'];
const TIER_NAMES: Record<keyof DiscoveryDirs, FoundCut['source']> = {
  projectDir: 'project',
  userDir: 'user',
  builtinDir: 'builtin',
};

function resolveTierRoots(tier: keyof DiscoveryDirs, dirs: DiscoveryDirs): string[] {
  switch (tier) {
    case 'projectDir':
      return [path.join(dirs.projectDir, '.suit', 'cuts')];
    case 'userDir':
      return [path.join(dirs.userDir, 'cuts')];
    case 'builtinDir':
      return [path.join(dirs.builtinDir, 'cuts')];
  }
}

async function listCutFilenames(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) out.push(path.join(dir, e.name));
      else if (e.isDirectory()) {
        const candidate = path.join(dir, e.name, 'cut.md');
        try {
          await fs.access(candidate);
          out.push(candidate);
        } catch {
          // not a cut dir
        }
      }
    }
  } catch {
    // dir doesn't exist
  }
  return out;
}

export async function findCut(name: string, dirs: DiscoveryDirs): Promise<FoundCut> {
  const seen: string[] = [];
  for (const tier of TIERS) {
    for (const root of resolveTierRoots(tier, dirs)) {
      const files = await listCutFilenames(root);
      for (const filepath of files) {
        const raw = await fs.readFile(filepath, 'utf8');
        const parsed = matter(raw);
        const result = CutSchema.safeParse(parsed.data);
        if (!result.success) continue;
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
    `cut not found: "${name}". Available: ${seen.length === 0 ? '(none)' : seen.join(', ')}`,
  );
}

export async function listAllCuts(dirs: DiscoveryDirs): Promise<FoundCut[]> {
  const found = new Map<string, FoundCut>();
  for (const tier of TIERS) {
    for (const root of resolveTierRoots(tier, dirs)) {
      const files = await listCutFilenames(root);
      for (const filepath of files) {
        const raw = await fs.readFile(filepath, 'utf8');
        const parsed = matter(raw);
        const result = CutSchema.safeParse(parsed.data);
        if (!result.success) continue;
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
