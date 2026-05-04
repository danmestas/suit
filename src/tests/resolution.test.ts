import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolve, writeResolutionArtifact, resolveAndPersist, resolveAgainstHarness, skillsKeepFromResolution } from '../lib/resolution.ts';
import type { ComponentSource } from '../lib/types.ts';

const skill = (name: string, category: string | undefined): ComponentSource => ({
  relativeDir: `skills/${name}`,
  dir: `/tmp/skills/${name}`,
  body: '',
  manifest: {
    name,
    version: '1.0.0',
    type: 'skill',
    description: '',
    targets: ['claude-code'],
    ...(category ? { category: { primary: category } } : {}),
  } as any,
});

describe('resolve', () => {
  it('returns full catalog when no outfit or mode is given', () => {
    const catalog = [skill('a', 'tooling'), skill('b', 'workflow')];
    const r = resolve({ catalog, harness: 'claude-code' });
    expect(r.skillsKeep).toBeNull();
    expect(r.skillsDrop).toEqual([]);
    expect(r.modePrompt).toBe('');
  });

  it('drops skills outside outfit categories', () => {
    const catalog = [skill('a', 'tooling'), skill('b', 'workflow')];
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const r = resolve({ catalog, outfit, harness: 'claude-code' });
    expect(r.skillsDrop).toContain('b');
    expect(r.skillsDrop).not.toContain('a');
  });

  it('keeps uncategorized skills (universal default)', () => {
    const catalog = [skill('a', 'tooling'), skill('b', undefined)];
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const r = resolve({ catalog, outfit, harness: 'claude-code' });
    expect(r.skillsDrop).not.toContain('b');
  });

  it('skill_include forces inclusion across categories', () => {
    const catalog = [skill('a', 'tooling'), skill('b', 'workflow')];
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: ['b'],
      skill_exclude: [],
    } as any;
    const r = resolve({ catalog, outfit, harness: 'claude-code' });
    expect(r.skillsDrop).not.toContain('b');
  });

  it('skill_exclude wins over category match', () => {
    const catalog = [skill('a', 'tooling')];
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: ['a'],
    } as any;
    const r = resolve({ catalog, outfit, harness: 'claude-code' });
    expect(r.skillsDrop).toContain('a');
  });

  it('outfit ∩ mode categories', () => {
    const catalog = [skill('a', 'tooling'), skill('b', 'workflow'), skill('c', 'philosophy')];
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling', 'workflow'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const mode = {
      name: 'm',
      type: 'mode',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const r = resolve({ catalog, outfit, mode, harness: 'claude-code' });
    expect(r.skillsDrop).toContain('b'); // in outfit but not in mode
    expect(r.skillsDrop).toContain('c'); // in neither
    expect(r.skillsDrop).not.toContain('a'); // in both
  });

  it('mode body becomes mode_prompt', () => {
    const catalog = [skill('a', 'tooling')];
    const mode = {
      name: 'm',
      type: 'mode',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const r = resolve({
      catalog,
      mode,
      modeBody: 'You are in focused mode.\n',
      harness: 'claude-code',
    });
    expect(r.modePrompt).toBe('You are in focused mode.\n');
  });

  it('emits resolved metadata', () => {
    const catalog = [skill('a', 'tooling')];
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const r = resolve({ catalog, outfit, harness: 'claude-code' });
    expect(r.metadata.outfit).toBe('p');
    expect(r.metadata.categories).toContain('tooling');
  });
});

describe('writeResolutionArtifact', () => {
  it('writes JSON to a tempfile and returns the path', async () => {
    const r: any = {
      schemaVersion: 1,
      harness: 'claude-code',
      skillsDrop: ['a'],
      skillsKeep: null,
      modePrompt: '',
      metadata: { outfit: null, mode: null, categories: [] },
    };
    const filepath = await writeResolutionArtifact(r);
    expect(filepath).toMatch(/resolution\.json$/);
    const content = await fs.readFile(filepath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.harness).toBe('claude-code');
    expect(parsed.skillsDrop).toEqual(['a']);
  });

  it('uses a session-scoped tempdir under os.tmpdir', async () => {
    const r: any = {
      schemaVersion: 1,
      harness: 'claude-code',
      skillsDrop: [],
      skillsKeep: null,
      modePrompt: '',
      metadata: { outfit: null, mode: null, categories: [] },
    };
    const filepath = await writeResolutionArtifact(r);
    expect(filepath.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(path.dirname(filepath))).toMatch(/^ac-sess-/);
  });
});

describe('resolveAndPersist', () => {
  it('returns both the in-memory resolution and a path to its on-disk artifact', async () => {
    const catalog = [skill('a', 'tooling'), skill('b', 'workflow')];
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const { resolution, artifactPath } = await resolveAndPersist({
      catalog,
      outfit,
      harness: 'claude-code',
    });
    expect(resolution.skillsDrop).toContain('b');
    expect(artifactPath).toMatch(/resolution\.json$/);
    const parsed = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
    expect(parsed.skillsDrop).toEqual(resolution.skillsDrop);
  });
});

describe('resolveAgainstHarness', () => {
  it('reads claude-code catalog from fake home and applies filter', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-'));
    await fs.mkdir(path.join(home, '.claude', 'skills', 'a'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.claude', 'skills', 'a', 'SKILL.md'),
      `---
name: a
description: a
category:
  primary: tooling
---
`,
    );
    await fs.mkdir(path.join(home, '.claude', 'skills', 'b'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.claude', 'skills', 'b', 'SKILL.md'),
      `---
name: b
description: b
category:
  primary: workflow
---
`,
    );
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const r = await resolveAgainstHarness({
      target: 'claude-code',
      harnessHome: home,
      outfit,
    });
    expect(r.skillsDrop).toContain('b');
    expect(r.skillsDrop).not.toContain('a');
  });
});

describe('resolve with accessories', () => {
  // Build a catalog covering several component types so the strict-include
  // validator can find / fail on each branch.
  const catalogWithExtras = (): ComponentSource[] => [
    skill('a', 'tooling'),
    skill('b', 'workflow'),
    skill('c', 'workflow'),
    {
      relativeDir: 'rules/pr-policy',
      dir: '/tmp/rules/pr-policy',
      body: '',
      manifest: {
        name: 'pr-policy',
        version: '1.0.0',
        type: 'rules',
        description: '',
        targets: ['claude-code'],
      } as any,
    },
    {
      relativeDir: 'hooks/trace',
      dir: '/tmp/hooks/trace',
      body: '',
      manifest: {
        name: 'trace',
        version: '1.0.0',
        type: 'hook',
        description: '',
        targets: ['claude-code'],
      } as any,
    },
    {
      relativeDir: 'agents/code-reviewer',
      dir: '/tmp/agents/code-reviewer',
      body: '',
      manifest: {
        name: 'code-reviewer',
        version: '1.0.0',
        type: 'agent',
        description: '',
        targets: ['claude-code'],
      } as any,
    },
  ];

  const accessory = (name: string, include: Partial<{ skills: string[]; rules: string[]; hooks: string[]; agents: string[]; commands: string[] }>) => ({
    name,
    version: '1.0.0',
    type: 'accessory' as const,
    description: '',
    targets: ['claude-code'],
    include: {
      skills: [],
      rules: [],
      hooks: [],
      agents: [],
      commands: [],
      ...include,
    },
  } as any);

  it('force-includes a skill the outfit would have dropped (category mismatch)', () => {
    const catalog = [skill('a', 'tooling'), skill('b', 'workflow')];
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const acc = accessory('extras', { skills: ['b'] });
    const r = resolve({ catalog, outfit, accessories: [acc], harness: 'claude-code' });
    expect(r.skillsDrop).not.toContain('b');
    expect(r.metadata.accessories).toEqual(['extras']);
  });

  it('multiple accessories layer in CLI order, both force-includes apply', () => {
    const catalog = [skill('a', 'tooling'), skill('b', 'workflow'), skill('c', 'workflow')];
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const acc1 = accessory('first', { skills: ['b'] });
    const acc2 = accessory('second', { skills: ['c'] });
    const r = resolve({ catalog, outfit, accessories: [acc1, acc2], harness: 'claude-code' });
    expect(r.skillsDrop).not.toContain('b');
    expect(r.skillsDrop).not.toContain('c');
    expect(r.metadata.accessories).toEqual(['first', 'second']);
  });

  it('exposes empty accessories array in metadata when none passed', () => {
    const catalog = [skill('a', 'tooling')];
    const r = resolve({ catalog, harness: 'claude-code' });
    expect(r.metadata.accessories).toEqual([]);
  });

  it('throws on missing skill reference in include', () => {
    const catalog = [skill('a', 'tooling')];
    const acc = accessory('tracing', { skills: ['otel-conventions'] });
    expect(() =>
      resolve({ catalog, accessories: [acc], harness: 'claude-code' }),
    ).toThrow(/accessory "tracing" includes skill "otel-conventions" not found in wardrobe/);
  });

  it('throws on missing hook reference in include', () => {
    const catalog = catalogWithExtras();
    const acc = accessory('tracing', { hooks: ['nonexistent-hook'] });
    expect(() =>
      resolve({ catalog, accessories: [acc], harness: 'claude-code' }),
    ).toThrow(/accessory "tracing" includes hook "nonexistent-hook" not found in wardrobe/);
  });

  it('throws on missing rule reference in include', () => {
    const catalog = catalogWithExtras();
    const acc = accessory('tracing', { rules: ['no-such-rule'] });
    expect(() =>
      resolve({ catalog, accessories: [acc], harness: 'claude-code' }),
    ).toThrow(/accessory "tracing" includes rule "no-such-rule" not found in wardrobe/);
  });

  it('throws on missing agent reference in include', () => {
    const catalog = catalogWithExtras();
    const acc = accessory('tracing', { agents: ['no-such-agent'] });
    expect(() =>
      resolve({ catalog, accessories: [acc], harness: 'claude-code' }),
    ).toThrow(/accessory "tracing" includes agent "no-such-agent" not found in wardrobe/);
  });

  it('passes when every include reference exists in the catalog', () => {
    const catalog = catalogWithExtras();
    const acc = accessory('full', {
      skills: ['a'],
      rules: ['pr-policy'],
      hooks: ['trace'],
      agents: ['code-reviewer'],
    });
    const r = resolve({ catalog, accessories: [acc], harness: 'claude-code' });
    expect(r.metadata.accessories).toEqual(['full']);
  });

  it('does not throw on commands references (no first-class type yet)', () => {
    const catalog = catalogWithExtras();
    const acc = accessory('cmds', { commands: ['anything'] });
    expect(() =>
      resolve({ catalog, accessories: [acc], harness: 'claude-code' }),
    ).not.toThrow();
  });

  it('writes accessories array into the resolution metadata', () => {
    const catalog = [skill('a', 'tooling'), skill('b', 'workflow')];
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const acc = accessory('layer1', { skills: ['b'] });
    const r = resolve({ catalog, outfit, accessories: [acc], harness: 'claude-code' });
    expect(r.metadata.accessories).toEqual(['layer1']);
  });
});

describe('skillsKeepFromResolution', () => {
  it('returns catalog skill names that are NOT in drop list', () => {
    const catalog = [
      { manifest: { type: 'skill', name: 'a' } } as any,
      { manifest: { type: 'skill', name: 'b' } } as any,
      { manifest: { type: 'skill', name: 'c' } } as any,
      { manifest: { type: 'rules', name: 'r' } } as any, // ignored — not a skill
    ];
    const keep = skillsKeepFromResolution(catalog, ['b']);
    expect(keep).toEqual(['a', 'c']);
  });
});
