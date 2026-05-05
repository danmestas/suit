import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { ComponentSource, Target } from '../types.js';

interface HarnessLayout {
  /** Subdir under home where this harness stores its skills */
  skillsDir: string;
  /** Filename containing the skill manifest (typically SKILL.md or skill.md) */
  manifestFile: string;
}

const LAYOUTS: Record<Target, HarnessLayout | null> = {
  'claude-code': { skillsDir: '.claude/skills', manifestFile: 'SKILL.md' },
  apm: { skillsDir: '.apm/skills', manifestFile: 'SKILL.md' },
  // v0.8: codex carries its own user-scope skills under `$CODEX_HOME/skills/`
  // (typically `~/.codex/skills/`). The catalog mirrors the claude-code layout
  // — same `SKILL.md` manifest file. This is consumed by the codex prelaunch
  // path to compute `skillsKeep` for the composed `CODEX_HOME` tempdir.
  codex: { skillsDir: '.codex/skills', manifestFile: 'SKILL.md' },
  gemini: { skillsDir: '.gemini/skills', manifestFile: 'skill.md' },
  copilot: null, // Copilot inlines into copilot-instructions.md
  pi: { skillsDir: '.pi/skills', manifestFile: 'SKILL.md' },
};

export async function loadHarnessCatalog(
  target: Target,
  homeDir: string,
): Promise<ComponentSource[]> {
  const layout = LAYOUTS[target];
  if (!layout) return [];
  const skillsRoot = path.join(homeDir, layout.skillsDir);
  let entries: string[];
  try {
    entries = await fs.readdir(skillsRoot);
  } catch {
    return [];
  }
  const out: ComponentSource[] = [];
  for (const name of entries) {
    const skillFile = path.join(skillsRoot, name, layout.manifestFile);
    let raw: string;
    try {
      raw = await fs.readFile(skillFile, 'utf8');
    } catch {
      continue;
    }
    const parsed = matter(raw);
    if (!parsed.data || typeof (parsed.data as any).name !== 'string') continue;
    out.push({
      relativeDir: `${layout.skillsDir}/${name}`,
      dir: path.join(skillsRoot, name),
      body: parsed.content,
      manifest: { type: 'skill', ...parsed.data } as any,
    });
  }
  return out;
}
