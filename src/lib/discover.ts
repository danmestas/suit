import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { ManifestSchema } from './schema.js';
import type { ComponentSource } from './types.js';

const COMPONENT_DIRS = [
  'skills',
  'plugins',
  'rules',
  'hooks',
  'agents',
  'mcp',
  'outfits',
  'modes',
  'accessories',
  // Note: 'commands' is intentionally not walked yet — there is no
  // CommandSchema in the discriminated union. Wardrobe v2 layout
  // includes a commands/ dir, but those manifests will be picked up
  // once a follow-up PR adds the schema type.
] as const;

const DIR_FILENAMES: Partial<Record<string, string[]>> = {
  outfits: ['outfit.md'],
  modes: ['mode.md'],
  accessories: ['accessory.md'],
  agents: ['AGENT.md', 'SKILL.md'],
  hooks: ['HOOK.md', 'SKILL.md'],
  // Wardrobe convention is `RULE.md` (singular), matching SKILL/HOOK/AGENT/COMMAND.
  // Schema's type literal is plural (`'rules'`) but file is singular. Accept both.
  rules: ['RULE.md', 'RULES.md', 'SKILL.md'],
};

function getComponentFilenames(dir: string): string[] {
  return DIR_FILENAMES[dir] ?? ['SKILL.md'];
}

export async function discoverComponents(repoRoot: string): Promise<ComponentSource[]> {
  const components: ComponentSource[] = [];
  for (const top of COMPONENT_DIRS) {
    const dir = path.join(repoRoot, top);
    const exists = await fs
      .stat(dir)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!exists) continue;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const componentDir = path.join(dir, entry.name);
      const candidates = getComponentFilenames(top);
      let skillPath: string | undefined;
      for (const name of candidates) {
        const candidate = path.join(componentDir, name);
        const exists = await fs.stat(candidate).then(() => true).catch(() => false);
        if (exists) {
          skillPath = candidate;
          break;
        }
      }
      if (!skillPath) continue;
      const raw = await fs.readFile(skillPath, 'utf8');
      const parsed = matter(raw);
      let manifest;
      try {
        manifest = ManifestSchema.parse(parsed.data);
      } catch (err) {
        if (err instanceof Error) {
          const prefixed = new Error(
            `${path.relative(repoRoot, skillPath)}: ${err.message}`,
            { cause: err },
          );
          prefixed.stack = err.stack;
          throw prefixed;
        }
        throw err;
      }
      components.push({
        dir: componentDir,
        relativeDir: path.relative(repoRoot, componentDir),
        manifest,
        body: parsed.content,
      });
    }
  }
  return components;
}
