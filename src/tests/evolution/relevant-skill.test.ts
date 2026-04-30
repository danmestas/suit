import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSkillCatalog } from '../../lib/evolution/relevant-skill.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

// TODO Phase 2: re-evaluate this test now that suit is tool-only and has no skills/ dir.
// In the legacy agent-config repo a skills/ catalog existed; in suit it does not
// (skills live in the external content repo discovered via SUIT_CONTENT_PATH).
describe.skip('scanSkillCatalog', () => {
  it('finds at least one skill in the repo-local catalog', async () => {
    const entries = await scanSkillCatalog({
      repoLocal: path.join(REPO_ROOT, 'skills'),
      home: undefined,
      pluginsCache: undefined,
    });
    expect(entries.length).toBeGreaterThan(0);
  });

  it('dedupes by name with repo-local priority', async () => {
    const entries = await scanSkillCatalog({
      repoLocal: path.join(REPO_ROOT, 'skills'),
      home: path.join(REPO_ROOT, 'skills'), // same dir simulates a duplicate
      pluginsCache: undefined,
    });
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
  });
});
