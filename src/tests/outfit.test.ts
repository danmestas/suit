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

  // ─── include block (issue #62) ────────────────────────────────────────────
  //
  // Outfits gain parity with cuts and accessories: an optional `include:`
  // block lets an outfit force-include hooks, agents, commands, and rules by
  // name. Skills stay on `skill_include`/`skill_exclude` for v1 (no breaking
  // change for existing outfits).

  it('defaults the include block to all-empty arrays when not declared (back-compat)', () => {
    const result = OutfitSchema.parse({
      name: 'backend',
      version: '1.0.0',
      type: 'outfit',
      description: 'x',
      targets: ['claude-code'],
      categories: ['tooling'],
    });
    expect(result.include.rules).toEqual([]);
    expect(result.include.hooks).toEqual([]);
    expect(result.include.agents).toEqual([]);
    expect(result.include.commands).toEqual([]);
  });

  it('accepts a populated include block on an outfit', () => {
    const result = OutfitSchema.safeParse({
      name: 'code',
      version: '1.0.0',
      type: 'outfit',
      description: 'x',
      targets: ['claude-code'],
      categories: ['tooling'],
      include: {
        hooks: ['rtk-suggest', 'rtk-rewrite'],
        agents: ['rtk-rust-expert'],
        rules: ['pr-policy'],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.include.hooks).toEqual(['rtk-suggest', 'rtk-rewrite']);
      expect(result.data.include.agents).toEqual(['rtk-rust-expert']);
      expect(result.data.include.rules).toEqual(['pr-policy']);
      expect(result.data.include.commands).toEqual([]);
    }
  });

  it('rejects include.skills on an outfit (use skill_include instead)', () => {
    // Issue #62 deliberately omits `include.skills` from v1 so the canonical
    // mechanism for skills stays `skill_include`/`skill_exclude`. The Zod
    // strict() shape rejects the unknown key with a clear-enough error that
    // points to the offending field.
    const result = OutfitSchema.safeParse({
      name: 'backend',
      version: '1.0.0',
      type: 'outfit',
      description: 'x',
      targets: ['claude-code'],
      categories: ['tooling'],
      include: {
        skills: ['idiomatic-go'],
        hooks: [],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Surface that the error is about the `skills` key specifically — so
      // authors who try the cut/accessory shape on an outfit get a precise
      // pointer rather than a generic "unrecognized key".
      const errText = result.error.issues.map((i) => i.message).join('\n');
      expect(errText.toLowerCase()).toMatch(/skills|unrecognized/);
    }
  });

  it('rejects other unknown keys inside outfit include (strict)', () => {
    const result = OutfitSchema.safeParse({
      name: 'backend',
      version: '1.0.0',
      type: 'outfit',
      description: 'x',
      targets: ['claude-code'],
      categories: ['tooling'],
      include: {
        bogus: ['nope'],
      },
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

