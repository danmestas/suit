import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { OutfitSchema } from '../lib/schema.ts';
import { findOutfit } from '../lib/outfit.ts';

describe('OutfitSchema', () => {
  it('accepts a minimal valid outfit', () => {
    const result = OutfitSchema.safeParse({
      name: 'backend',
      version: '1.0.0',
      type: 'outfit',
      description: 'Backend dev work',
      targets: ['claude-code'],
      categories: ['tooling'],
    });
    expect(result.success).toBe(true);
  });

  it('defaults skill_include and skill_exclude to empty arrays', () => {
    const result = OutfitSchema.parse({
      name: 'backend',
      version: '1.0.0',
      type: 'outfit',
      description: 'Backend dev work',
      targets: ['claude-code'],
      categories: ['tooling'],
    });
    expect(result.skill_include).toEqual([]);
    expect(result.skill_exclude).toEqual([]);
  });

  it('rejects missing categories field', () => {
    const result = OutfitSchema.safeParse({
      name: 'backend',
      version: '1.0.0',
      type: 'outfit',
      description: 'Backend dev work',
      targets: ['claude-code'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects type other than "outfit"', () => {
    const result = OutfitSchema.safeParse({
      name: 'backend',
      version: '1.0.0',
      type: 'skill',
      description: 'x',
      targets: ['claude-code'],
      categories: ['tooling'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a compose field with venn-diagram expressions', () => {
    const result = OutfitSchema.safeParse({
      name: 'quick',
      version: '0.1.0',
      type: 'outfit',
      description: 'Composed generalist',
      targets: ['claude-code'],
      categories: ['workflow'],
      compose: ['implementer + planner + reviewer'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.compose).toEqual(['implementer + planner + reviewer']);
    }
  });

  it('defaults compose to an empty array when omitted (back-compat)', () => {
    const result = OutfitSchema.parse({
      name: 'backend',
      version: '1.0.0',
      type: 'outfit',
      description: 'x',
      targets: ['claude-code'],
      categories: ['tooling'],
    });
    expect(result.compose).toEqual([]);
  });

  it('rejects compose entries that are not strings', () => {
    const result = OutfitSchema.safeParse({
      name: 'bad',
      version: '0.1.0',
      type: 'outfit',
      description: 'x',
      targets: ['claude-code'],
      categories: ['tooling'],
      compose: [123],
    });
    expect(result.success).toBe(false);
  });
});

describe('findOutfit (3-tier discovery)', () => {
  it('finds a outfit in user-scope dir', async () => {
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-user-'));
    await fs.mkdir(path.join(userDir, 'outfits'));
    await fs.writeFile(
      path.join(userDir, 'outfits', 'mine.md'),
      `---
name: mine
version: 1.0.0
type: outfit
description: t
targets: [claude-code]
categories: [tooling]
---
`,
    );
    const result = await findOutfit('mine', {
      projectDir: '/nonexistent',
      userDir,
      builtinDir: '/nonexistent',
    });
    expect(result.manifest.name).toBe('mine');
    expect(result.source).toBe('user');
  });

  it('project-scope wins over user-scope', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-proj-'));
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-user-'));
    await fs.mkdir(path.join(projectDir, '.suit', 'outfits'), { recursive: true });
    await fs.mkdir(path.join(userDir, 'outfits'));
    await fs.writeFile(
      path.join(projectDir, '.suit', 'outfits', 'mine.md'),
      `---
name: mine
version: 1.0.0
type: outfit
description: project
targets: [claude-code]
categories: [tooling]
---
`,
    );
    await fs.writeFile(
      path.join(userDir, 'outfits', 'mine.md'),
      `---
name: mine
version: 1.0.0
type: outfit
description: user
targets: [claude-code]
categories: [tooling]
---
`,
    );
    const result = await findOutfit('mine', {
      projectDir,
      userDir,
      builtinDir: '/nonexistent',
    });
    expect(result.manifest.description).toBe('project');
    expect(result.source).toBe('project');
  });

  it('throws with a list of available names when not found', async () => {
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-user-'));
    await fs.mkdir(path.join(userDir, 'outfits'));
    await fs.writeFile(
      path.join(userDir, 'outfits', 'one.md'),
      `---
name: one
version: 1.0.0
type: outfit
description: t
targets: [claude-code]
categories: [tooling]
---
`,
    );
    await expect(
      findOutfit('nope', { projectDir: '/nonexistent', userDir, builtinDir: '/nonexistent' }),
    ).rejects.toThrow(/one/);
  });
});

