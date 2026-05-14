import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { FitSchema } from '../lib/schema.ts';
import { findFit, listAllFits } from '../lib/fit.ts';
import { resolve as resolveSession } from '../lib/resolution.ts';
import type { ComponentSource } from '../lib/types.ts';

describe('FitSchema', () => {
  it('accepts a minimal valid fit', () => {
    const result = FitSchema.safeParse({
      name: 'senior-engineer',
      version: '1.0.0',
      type: 'fit',
      description: 'Senior tier — design judgment',
      targets: ['claude-code'],
      categories: ['workflow'],
    });
    expect(result.success).toBe(true);
  });

  it('defaults skill_include and skill_exclude to empty arrays', () => {
    const result = FitSchema.parse({
      name: 'engineer',
      version: '1.0.0',
      type: 'fit',
      description: 'x',
      targets: ['claude-code'],
      categories: ['workflow'],
    });
    expect(result.skill_include).toEqual([]);
    expect(result.skill_exclude).toEqual([]);
  });

  it('rejects type other than "fit"', () => {
    const result = FitSchema.safeParse({
      name: 'engineer',
      version: '1.0.0',
      type: 'cut',
      description: 'x',
      targets: ['claude-code'],
      categories: ['workflow'],
    });
    expect(result.success).toBe(false);
  });

  it('defaults all 5 include sub-arrays to empty when no include block is declared', () => {
    const result = FitSchema.parse({
      name: 'engineer',
      version: '1.0.0',
      type: 'fit',
      description: 'x',
      targets: ['claude-code'],
      categories: ['workflow'],
    });
    expect(result.include.skills).toEqual([]);
    expect(result.include.rules).toEqual([]);
    expect(result.include.hooks).toEqual([]);
    expect(result.include.agents).toEqual([]);
    expect(result.include.commands).toEqual([]);
  });

  it('accepts a populated include block on a fit', () => {
    const result = FitSchema.safeParse({
      name: 'staff-engineer',
      version: '1.0.0',
      type: 'fit',
      description: 'x',
      targets: ['claude-code'],
      categories: ['workflow'],
      include: {
        skills: ['ousterhout', 'tigerstyle'],
        agents: ['architect-review'],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.include.skills).toEqual(['ousterhout', 'tigerstyle']);
      expect(result.data.include.agents).toEqual(['architect-review']);
      expect(result.data.include.rules).toEqual([]);
    }
  });

  it('rejects unknown keys inside fit include (strict)', () => {
    const result = FitSchema.safeParse({
      name: 'engineer',
      version: '1.0.0',
      type: 'fit',
      description: 'x',
      targets: ['claude-code'],
      categories: ['workflow'],
      include: {
        skills: ['writing-plans'],
        bogus: ['nope'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('defaults enable/disable blocks to all-empty arrays', () => {
    const result = FitSchema.parse({
      name: 'engineer',
      version: '1.0.0',
      type: 'fit',
      description: 'x',
      targets: ['claude-code'],
      categories: ['workflow'],
    });
    expect(result.enable.plugins).toEqual([]);
    expect(result.enable.mcps).toEqual([]);
    expect(result.enable.hooks).toEqual([]);
    expect(result.disable.plugins).toEqual([]);
  });
});

describe('findFit (3-tier discovery)', () => {
  it('finds a fit in the user-scope dir and parses the body', async () => {
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-fit-user-'));
    await fs.mkdir(path.join(userDir, 'fits'));
    await fs.writeFile(
      path.join(userDir, 'fits', 'engineer.md'),
      `---
name: engineer
version: 1.0.0
type: fit
description: standard tier
targets: [claude-code]
categories: [workflow]
---

You are operating at engineer tier.
`,
    );
    const result = await findFit('engineer', {
      projectDir: '/nonexistent',
      userDir,
      builtinDir: '/nonexistent',
    });
    expect(result.manifest.name).toBe('engineer');
    expect(result.source).toBe('user');
    expect(result.body.trim()).toBe('You are operating at engineer tier.');
  });

  it('finds a fit in builtin-scope dir using fit.md package layout', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-fit-builtin-'));
    await fs.mkdir(path.join(builtinDir, 'fits', 'senior-engineer'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'fits', 'senior-engineer', 'fit.md'),
      `---
name: senior-engineer
version: 1.0.0
type: fit
description: senior tier
targets: [claude-code]
categories: [workflow]
---
body
`,
    );
    const result = await findFit('senior-engineer', {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
    });
    expect(result.manifest.name).toBe('senior-engineer');
    expect(result.source).toBe('builtin');
  });

  it('project-scope wins over user-scope for fits', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-fit-proj-'));
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-fit-user-'));
    await fs.mkdir(path.join(projectDir, '.suit', 'fits'), { recursive: true });
    await fs.mkdir(path.join(userDir, 'fits'));
    await fs.writeFile(
      path.join(projectDir, '.suit', 'fits', 'engineer.md'),
      `---
name: engineer
version: 2.0.0
type: fit
description: project-version
targets: [claude-code]
categories: [workflow]
---
`,
    );
    await fs.writeFile(
      path.join(userDir, 'fits', 'engineer.md'),
      `---
name: engineer
version: 1.0.0
type: fit
description: user-version
targets: [claude-code]
categories: [workflow]
---
`,
    );
    const result = await findFit('engineer', {
      projectDir,
      userDir,
      builtinDir: '/nonexistent',
    });
    expect(result.manifest.description).toBe('project-version');
    expect(result.source).toBe('project');
  });

  it('throws with a list of available names when not found', async () => {
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-fit-user-'));
    await fs.mkdir(path.join(userDir, 'fits'));
    await fs.writeFile(
      path.join(userDir, 'fits', 'engineer.md'),
      `---
name: engineer
version: 1.0.0
type: fit
description: t
targets: [claude-code]
categories: [workflow]
---
`,
    );
    await expect(
      findFit('nope', {
        projectDir: '/nonexistent',
        userDir,
        builtinDir: '/nonexistent',
      }),
    ).rejects.toThrow(/fit not found.*engineer/);
  });

  it('throws clear error listing (none) when no fits exist anywhere', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-fit-empty-'));
    await expect(
      findFit('engineer', {
        projectDir: tmp,
        userDir: tmp,
        builtinDir: tmp,
      }),
    ).rejects.toThrow(/fit not found.*\(none\)/);
  });
});

describe('listAllFits', () => {
  it('returns all fits from all tiers, deduped by name with project winning', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-fit-proj-'));
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-fit-user-'));
    await fs.mkdir(path.join(projectDir, '.suit', 'fits'), { recursive: true });
    await fs.mkdir(path.join(userDir, 'fits'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.suit', 'fits', 'shared.md'),
      `---
name: shared
version: 1.0.0
type: fit
description: project-version
targets: [claude-code]
categories: [workflow]
---
`,
    );
    await fs.writeFile(
      path.join(userDir, 'fits', 'shared.md'),
      `---
name: shared
version: 1.0.0
type: fit
description: user-version
targets: [claude-code]
categories: [workflow]
---
`,
    );
    await fs.writeFile(
      path.join(userDir, 'fits', 'only-user.md'),
      `---
name: only-user
version: 1.0.0
type: fit
description: user-only
targets: [claude-code]
categories: [workflow]
---
`,
    );
    const all = await listAllFits({
      projectDir,
      userDir,
      builtinDir: '/nonexistent',
    });
    expect(all.length).toBe(2);
    const shared = all.find((m) => m.manifest.name === 'shared')!;
    expect(shared.source).toBe('project');
    expect(shared.manifest.description).toBe('project-version');
  });

  it('returns empty list when no fits exist anywhere', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-fit-empty-'));
    const all = await listAllFits({
      projectDir: tmp,
      userDir: tmp,
      builtinDir: tmp,
    });
    expect(all).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Layer composition: fit between outfit and cut.
// --------------------------------------------------------------------------

describe('fit composition in resolve()', () => {
  function makeCatalog(): ComponentSource[] {
    return [
      {
        relativeDir: 'skills/writing-plans',
        dir: '/tmp/skills/writing-plans',
        body: '',
        manifest: {
          name: 'writing-plans',
          version: '1.0.0',
          type: 'skill',
          description: '',
          targets: ['claude-code'],
          category: { primary: 'workflow' },
        } as any,
      },
      {
        relativeDir: 'skills/ousterhout',
        dir: '/tmp/skills/ousterhout',
        body: '',
        manifest: {
          name: 'ousterhout',
          version: '1.0.0',
          type: 'skill',
          description: '',
          targets: ['claude-code'],
          category: { primary: 'workflow' },
        } as any,
      },
      {
        relativeDir: 'skills/farley',
        dir: '/tmp/skills/farley',
        body: '',
        manifest: {
          name: 'farley',
          version: '1.0.0',
          type: 'skill',
          description: '',
          targets: ['claude-code'],
          category: { primary: 'workflow' },
        } as any,
      },
    ];
  }

  it('fit.skill_include force-loads a skill the outfit otherwise drops', () => {
    const catalog = makeCatalog();
    const outfit = {
      name: 'minimal',
      type: 'outfit',
      categories: ['economy'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const fit = {
      name: 'engineer',
      type: 'fit',
      categories: ['workflow'],
      skill_include: ['writing-plans'],
      skill_exclude: [],
    } as any;
    const r = resolveSession({
      catalog,
      outfit,
      fit,
      harness: 'claude-code',
    });
    expect(r.skillsDrop).not.toContain('writing-plans');
    expect(r.metadata.fit).toBe('engineer');
  });

  it('fit.skill_exclude drops a skill the outfit included', () => {
    const catalog = makeCatalog();
    const outfit = {
      name: 'role',
      type: 'outfit',
      categories: ['workflow'],
      skill_include: ['ousterhout'],
      skill_exclude: [],
    } as any;
    const fit = {
      name: 'junior-engineer',
      type: 'fit',
      categories: ['workflow'],
      skill_include: [],
      skill_exclude: ['ousterhout'],
    } as any;
    const r = resolveSession({
      catalog,
      outfit,
      fit,
      harness: 'claude-code',
    });
    expect(r.skillsDrop).toContain('ousterhout');
  });

  it('fit.include.skills rescues a category-dropped skill', () => {
    // 'farley' is in 'workflow' category; the outfit's category set is
    // 'economy' so 'farley' gets dropped. The fit's include.skills rescues it
    // via the force-include phase.
    const catalog = makeCatalog();
    const outfit = {
      name: 'role',
      type: 'outfit',
      categories: ['economy'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const fit = {
      name: 'senior-engineer',
      type: 'fit',
      categories: [],
      skill_include: [],
      skill_exclude: [],
      include: {
        skills: ['farley'],
        rules: [],
        hooks: [],
        agents: [],
        commands: [],
      },
    } as any;
    const r = resolveSession({
      catalog,
      outfit,
      fit,
      harness: 'claude-code',
    });
    expect(r.skillsDrop).not.toContain('farley');
  });

  it('layer order: outfit → fit → cut produces unioned prose in cutPrompt', () => {
    const catalog = makeCatalog();
    const fit = {
      name: 'engineer',
      type: 'fit',
      categories: [],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const cut = {
      name: 'executing',
      type: 'cut',
      categories: [],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const r = resolveSession({
      catalog,
      fit,
      cut,
      fitBody: 'FIT BODY',
      cutBody: 'CUT BODY',
      harness: 'claude-code',
    });
    // Both bodies present — joined with a blank line, fit first then cut.
    expect(r.cutPrompt).toBe('FIT BODY\n\nCUT BODY');
  });

  it('cutPrompt is fitBody verbatim when no cut is supplied', () => {
    const catalog = makeCatalog();
    const fit = {
      name: 'engineer',
      type: 'fit',
      categories: [],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const r = resolveSession({
      catalog,
      fit,
      fitBody: 'FIT ONLY',
      harness: 'claude-code',
    });
    expect(r.cutPrompt).toBe('FIT ONLY');
  });

  it('metadata.fit is null when no fit is supplied', () => {
    const catalog = makeCatalog();
    const outfit = {
      name: 'role',
      type: 'outfit',
      categories: ['workflow'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const r = resolveSession({
      catalog,
      outfit,
      harness: 'claude-code',
    });
    expect(r.metadata.fit).toBeNull();
  });

  it('progressive category intersection across outfit + fit + cut', () => {
    const catalog = makeCatalog();
    const outfit = {
      name: 'role',
      type: 'outfit',
      categories: ['workflow', 'economy'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const fit = {
      name: 'engineer',
      type: 'fit',
      categories: ['workflow'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const r = resolveSession({
      catalog,
      outfit,
      fit,
      harness: 'claude-code',
    });
    // Intersection of {workflow, economy} ∩ {workflow} = {workflow}.
    expect(r.metadata.categories.sort()).toEqual(['workflow']);
  });

  it('fit with empty categories does not constrain the category set', () => {
    const catalog = makeCatalog();
    const outfit = {
      name: 'role',
      type: 'outfit',
      categories: ['workflow', 'economy'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const fit = {
      name: 'engineer',
      type: 'fit',
      categories: [],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const r = resolveSession({
      catalog,
      outfit,
      fit,
      harness: 'claude-code',
    });
    // fit has empty categories — outfit's set survives unchanged.
    expect(r.metadata.categories.sort()).toEqual(['economy', 'workflow']);
  });
});
