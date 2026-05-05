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

describe('resolve with mode include (Phase 3)', () => {
  // Reuse a small catalog with extra component types so strict-include
  // validation can succeed/fail on each branch.
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

  // Helpers to construct mode and accessory manifests inline. The cast to any
  // mirrors the existing accessory-block tests above and keeps the test
  // surface focused on resolve() behavior, not on schema parsing.
  const modeWithInclude = (
    name: string,
    categories: string[],
    include: Partial<{
      skills: string[];
      rules: string[];
      hooks: string[];
      agents: string[];
      commands: string[];
    }>,
  ) => ({
    name,
    version: '1.0.0',
    type: 'mode' as const,
    description: '',
    targets: ['claude-code'],
    categories,
    skill_include: [],
    skill_exclude: [],
    include: {
      skills: [],
      rules: [],
      hooks: [],
      agents: [],
      commands: [],
      ...include,
    },
  } as any);

  const accessoryWithInclude = (
    name: string,
    include: Partial<{
      skills: string[];
      rules: string[];
      hooks: string[];
      agents: string[];
      commands: string[];
    }>,
  ) => ({
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

  it('mode without include block resolves identically to before (back-compat)', () => {
    const catalog = [skill('a', 'tooling'), skill('b', 'workflow')];
    // Hand-build a "v0.3-shaped" mode manifest with the include block defaulted
    // to all-empty arrays — this is what ModeSchema.parse() emits today for any
    // body-only mode in the wardrobe.
    const mode = {
      name: 'm',
      type: 'mode',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
      include: { skills: [], rules: [], hooks: [], agents: [], commands: [] },
    } as any;
    const r = resolve({ catalog, mode, harness: 'claude-code' });
    expect(r.skillsDrop).toContain('b');
    expect(r.skillsDrop).not.toContain('a');
    expect(r.metadata.mode).toBe('m');
  });

  it('mode.include.skills force-includes a skill the category filter would have dropped', () => {
    const catalog = [skill('a', 'tooling'), skill('b', 'workflow')];
    const mode = modeWithInclude('m', ['tooling'], { skills: ['b'] });
    const r = resolve({ catalog, mode, harness: 'claude-code' });
    expect(r.skillsDrop).not.toContain('b');
    expect(r.metadata.mode).toBe('m');
  });

  it('throws on missing skill reference in mode include', () => {
    const catalog = [skill('a', 'tooling')];
    const mode = modeWithInclude('ticket-writing', ['tooling'], {
      skills: ['linear-method'],
    });
    expect(() =>
      resolve({ catalog, mode, harness: 'claude-code' }),
    ).toThrow(/mode "ticket-writing" includes skill "linear-method" not found in wardrobe/);
  });

  it('throws on missing rule reference in mode include', () => {
    const catalog = catalogWithExtras();
    const mode = modeWithInclude('m', ['workflow'], {
      rules: ['no-such-rule'],
    });
    expect(() =>
      resolve({ catalog, mode, harness: 'claude-code' }),
    ).toThrow(/mode "m" includes rule "no-such-rule" not found in wardrobe/);
  });

  it('throws on missing hook reference in mode include', () => {
    const catalog = catalogWithExtras();
    const mode = modeWithInclude('m', ['workflow'], {
      hooks: ['nonexistent-hook'],
    });
    expect(() =>
      resolve({ catalog, mode, harness: 'claude-code' }),
    ).toThrow(/mode "m" includes hook "nonexistent-hook" not found in wardrobe/);
  });

  it('throws on missing agent reference in mode include', () => {
    const catalog = catalogWithExtras();
    const mode = modeWithInclude('m', ['workflow'], {
      agents: ['no-such-agent'],
    });
    expect(() =>
      resolve({ catalog, mode, harness: 'claude-code' }),
    ).toThrow(/mode "m" includes agent "no-such-agent" not found in wardrobe/);
  });

  it('error speaker is "mode" (not "accessory") when a mode include is bad', () => {
    const catalog = catalogWithExtras();
    const mode = modeWithInclude('ticket-writing', ['workflow'], {
      skills: ['linear-method'],
    });
    expect(() => resolve({ catalog, mode, harness: 'claude-code' })).toThrow(
      /mode "ticket-writing"/,
    );
    expect(() => resolve({ catalog, mode, harness: 'claude-code' })).not.toThrow(
      /accessory "ticket-writing"/,
    );
  });

  it('passes when every mode include reference exists in the catalog', () => {
    const catalog = catalogWithExtras();
    const mode = modeWithInclude('m', ['workflow'], {
      skills: ['a'],
      rules: ['pr-policy'],
      hooks: ['trace'],
      agents: ['code-reviewer'],
    });
    const r = resolve({ catalog, mode, harness: 'claude-code' });
    expect(r.metadata.mode).toBe('m');
  });

  it('mode include + accessory include both apply, mode runs first then accessory', () => {
    // Outfit categories=[tooling]; mode adds 'b' (workflow); accessory adds 'c'
    // (workflow). Without overlays, both b and c would be dropped.
    const catalog = [skill('a', 'tooling'), skill('b', 'workflow'), skill('c', 'workflow')];
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const mode = modeWithInclude('m', ['tooling'], { skills: ['b'] });
    const acc = accessoryWithInclude('extras', { skills: ['c'] });
    const r = resolve({ catalog, outfit, mode, accessories: [acc], harness: 'claude-code' });
    expect(r.skillsDrop).not.toContain('b');
    expect(r.skillsDrop).not.toContain('c');
    expect(r.metadata.mode).toBe('m');
    expect(r.metadata.accessories).toEqual(['extras']);
  });

  it('mode include and accessory include naming the same skill converge to the same kept-set (last-wins is a no-op for force-include)', () => {
    // Both layers list 'b'. Documented order is mode-first, accessory-second;
    // since force-include is set-deletion, the resulting drop-set is identical
    // regardless of order — this test locks that semantic.
    const catalog = [skill('a', 'tooling'), skill('b', 'workflow')];
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const mode = modeWithInclude('m', ['tooling'], { skills: ['b'] });
    const acc = accessoryWithInclude('extras', { skills: ['b'] });
    const r = resolve({ catalog, outfit, mode, accessories: [acc], harness: 'claude-code' });
    expect(r.skillsDrop).not.toContain('b');
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

// ─── globals filtering (Phase D, v0.7) ─────────────────────────────────────
//
// These tests assert the layered enable/disable semantics over a globals.yaml
// baseline. Layers are applied in CLI declaration order: outfit, mode, then
// accessories[]. Within each layer `disable` runs before `enable`. The
// metadata.globals shape is the single source-of-truth for downstream
// symlink-farm filtering.

const fakeGlobals = (
  plugins: string[] = [],
  mcps: string[] = [],
  hooks: string[] = [],
) => ({
  schemaVersion: 1 as const,
  generated_at: '2024-01-01T00:00:00.000Z',
  machine: 'test',
  plugins: Object.fromEntries(
    plugins.map((n) => [
      n,
      { source: 'manual', install: 'fake', discover_path: `~/.claude/plugins/${n}` },
    ]),
  ),
  mcps: Object.fromEntries(
    mcps.map((n) => [
      n,
      {
        source: 'claude-code-config',
        type: 'stdio',
        command: 'fake',
        has_env: false,
        discover_path: `~/.claude.json#mcpServers/${n}`,
      },
    ]),
  ),
  hooks: Object.fromEntries(
    hooks.map((n) => [
      n,
      { source: 'claude-code-hooks', discover_path: `~/.claude/hooks/${n}` },
    ]),
  ),
}) as any;

describe('resolve — globals filtering (Phase D)', () => {
  it('returns all-empty metadata.globals when no registry passed', () => {
    const r = resolve({ catalog: [], harness: 'claude-code' });
    expect(r.metadata.globals).toEqual({
      plugins: { kept: [], dropped: [], unresolved: [] },
      mcps: { kept: [], dropped: [], unresolved: [] },
      hooks: { kept: [], dropped: [], unresolved: [] },
    });
  });

  it('keeps all globals as baseline when no enable/disable layers', () => {
    const globals = fakeGlobals(['p1', 'p2'], ['m1'], ['h1']);
    const r = resolve({ catalog: [], harness: 'claude-code', globals });
    expect(r.metadata.globals.plugins.kept).toEqual(['p1', 'p2']);
    expect(r.metadata.globals.plugins.dropped).toEqual([]);
    expect(r.metadata.globals.mcps.kept).toEqual(['m1']);
    expect(r.metadata.globals.hooks.kept).toEqual(['h1']);
  });

  it('outfit.disable removes a plugin from kept', () => {
    const globals = fakeGlobals(['p1', 'p2', 'p3']);
    const outfit = {
      name: 'p',
      type: 'outfit',
      categories: [],
      skill_include: [],
      skill_exclude: [],
      enable: { plugins: [], mcps: [], hooks: [] },
      disable: { plugins: ['p2'], mcps: [], hooks: [] },
    } as any;
    const r = resolve({ catalog: [], outfit, harness: 'claude-code', globals });
    expect(r.metadata.globals.plugins.kept).toEqual(['p1', 'p3']);
    expect(r.metadata.globals.plugins.dropped).toEqual(['p2']);
  });

  it('mode.disable layered on top of outfit.disable accumulates', () => {
    const globals = fakeGlobals(['p1', 'p2', 'p3']);
    const outfit = {
      name: 'p', type: 'outfit', categories: [], skill_include: [], skill_exclude: [],
      enable: { plugins: [], mcps: [], hooks: [] },
      disable: { plugins: ['p1'], mcps: [], hooks: [] },
    } as any;
    const mode = {
      name: 'm', type: 'mode', categories: [], skill_include: [], skill_exclude: [],
      enable: { plugins: [], mcps: [], hooks: [] },
      disable: { plugins: ['p2'], mcps: [], hooks: [] },
    } as any;
    const r = resolve({ catalog: [], outfit, mode, harness: 'claude-code', globals });
    expect(r.metadata.globals.plugins.kept).toEqual(['p3']);
    expect(r.metadata.globals.plugins.dropped).toEqual(['p1', 'p2']);
  });

  it('accessory.enable re-adds a plugin disabled by outfit', () => {
    const globals = fakeGlobals(['p1', 'p2']);
    const outfit = {
      name: 'p', type: 'outfit', categories: [], skill_include: [], skill_exclude: [],
      enable: { plugins: [], mcps: [], hooks: [] },
      disable: { plugins: ['p2'], mcps: [], hooks: [] },
    } as any;
    const acc = {
      name: 'a', type: 'accessory',
      include: { skills: [], rules: [], hooks: [], agents: [], commands: [] },
      enable: { plugins: ['p2'], mcps: [], hooks: [] },
      disable: { plugins: [], mcps: [], hooks: [] },
    } as any;
    const r = resolve({ catalog: [], outfit, accessories: [acc], harness: 'claude-code', globals });
    expect(r.metadata.globals.plugins.kept).toEqual(['p1', 'p2']);
    expect(r.metadata.globals.plugins.dropped).toEqual([]);
  });

  it('disable referencing absent name is silent no-op (idempotent)', () => {
    const globals = fakeGlobals(['p1']);
    const outfit = {
      name: 'p', type: 'outfit', categories: [], skill_include: [], skill_exclude: [],
      enable: { plugins: [], mcps: [], hooks: [] },
      disable: { plugins: ['ghost', 'ghost'], mcps: [], hooks: [] }, // ghost not in registry; doubled in same layer
    } as any;
    const warns: string[] = [];
    const r = resolve({ catalog: [], outfit, harness: 'claude-code', globals, warn: (m) => warns.push(m) });
    expect(r.metadata.globals.plugins.kept).toEqual(['p1']);
    expect(r.metadata.globals.plugins.unresolved).toEqual([]);
    expect(warns).toEqual([]); // disable on absent → no warning
  });

  it('enable referencing name not in globals registry warns and tracks unresolved', () => {
    const globals = fakeGlobals(['p1']);
    const outfit = {
      name: 'p', type: 'outfit', categories: [], skill_include: [], skill_exclude: [],
      enable: { plugins: ['mystery'], mcps: [], hooks: [] },
      disable: { plugins: [], mcps: [], hooks: [] },
    } as any;
    const warns: string[] = [];
    const r = resolve({ catalog: [], outfit, harness: 'claude-code', globals, warn: (m) => warns.push(m) });
    expect(r.metadata.globals.plugins.kept).toEqual(['p1']);
    expect(r.metadata.globals.plugins.unresolved).toEqual(['mystery']);
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatch(/mystery/);
    expect(warns[0]).toMatch(/outfit "p"/);
  });

  it('layer-order convergence: outfit.disable + mode.disable + accessory.enable', () => {
    // Build a complex case: registry [a,b,c,d]; outfit disables [a,b];
    // mode disables [c]; accessory1 enables [a]; accessory2 enables [c, d-already-kept].
    // Expected kept: a (re-added), c (re-added), d (always kept). Dropped: b.
    const globals = fakeGlobals(['a', 'b', 'c', 'd']);
    const outfit = {
      name: 'o', type: 'outfit', categories: [], skill_include: [], skill_exclude: [],
      enable: { plugins: [], mcps: [], hooks: [] },
      disable: { plugins: ['a', 'b'], mcps: [], hooks: [] },
    } as any;
    const mode = {
      name: 'm', type: 'mode', categories: [], skill_include: [], skill_exclude: [],
      enable: { plugins: [], mcps: [], hooks: [] },
      disable: { plugins: ['c'], mcps: [], hooks: [] },
    } as any;
    const acc1 = {
      name: 'acc1', type: 'accessory',
      include: { skills: [], rules: [], hooks: [], agents: [], commands: [] },
      enable: { plugins: ['a'], mcps: [], hooks: [] },
      disable: { plugins: [], mcps: [], hooks: [] },
    } as any;
    const acc2 = {
      name: 'acc2', type: 'accessory',
      include: { skills: [], rules: [], hooks: [], agents: [], commands: [] },
      enable: { plugins: ['c', 'd'], mcps: [], hooks: [] },
      disable: { plugins: [], mcps: [], hooks: [] },
    } as any;
    const r = resolve({
      catalog: [], outfit, mode, accessories: [acc1, acc2],
      harness: 'claude-code', globals,
    });
    expect(r.metadata.globals.plugins.kept).toEqual(['a', 'c', 'd']);
    expect(r.metadata.globals.plugins.dropped).toEqual(['b']);
  });

  it('disable wins within a single layer (disable runs before enable)', () => {
    // Same layer disables and enables the same name → final state is enabled,
    // because enable runs second within the layer. This is the contract.
    const globals = fakeGlobals(['p1']);
    const outfit = {
      name: 'p', type: 'outfit', categories: [], skill_include: [], skill_exclude: [],
      enable: { plugins: ['p1'], mcps: [], hooks: [] },
      disable: { plugins: ['p1'], mcps: [], hooks: [] },
    } as any;
    const r = resolve({ catalog: [], outfit, harness: 'claude-code', globals });
    expect(r.metadata.globals.plugins.kept).toEqual(['p1']);
  });

  it('mcps and hooks filter independently from plugins', () => {
    const globals = fakeGlobals(['p1'], ['m1', 'm2'], ['h1', 'h2']);
    const outfit = {
      name: 'p', type: 'outfit', categories: [], skill_include: [], skill_exclude: [],
      enable: { plugins: [], mcps: [], hooks: [] },
      disable: { plugins: [], mcps: ['m1'], hooks: ['h2'] },
    } as any;
    const r = resolve({ catalog: [], outfit, harness: 'claude-code', globals });
    expect(r.metadata.globals.plugins.kept).toEqual(['p1']);
    expect(r.metadata.globals.mcps.kept).toEqual(['m2']);
    expect(r.metadata.globals.hooks.kept).toEqual(['h1']);
  });
});
