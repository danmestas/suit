import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { loadRepoConfig } from '../lib/config.ts';

describe('loadRepoConfig', () => {
  it('parses suit.config.yaml when present', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'suit-cfg-'));
    await fs.writeFile(
      path.join(tmp, 'suit.config.yaml'),
      'codex:\n  agents_md_section_order: [rules, agents, skills]\n',
    );
    const cfg = await loadRepoConfig(tmp);
    expect(cfg['codex']).toEqual({ agents_md_section_order: ['rules', 'agents', 'skills'] });
  });

  it('returns empty config when file missing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'suit-cfg-'));
    const cfg = await loadRepoConfig(tmp);
    expect(cfg).toEqual({});
  });
});
