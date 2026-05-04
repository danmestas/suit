import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { AccessorySchema } from '../lib/schema.ts';
import { findAccessory, listAllAccessories } from '../lib/accessory.ts';
import { resolve as resolveSession } from '../lib/resolution.ts';
import type { ComponentSource } from '../lib/types.ts';

describe('AccessorySchema', () => {
  it('accepts a minimal valid accessory', () => {
    const result = AccessorySchema.safeParse({
      name: 'tracing',
      version: '1.0.0',
      type: 'accessory',
      description: 'Add OpenTelemetry tracing',
      targets: ['claude-code'],
    });
    expect(result.success).toBe(true);
  });

  it('defaults all 5 include sub-arrays to empty', () => {
    const result = AccessorySchema.parse({
      name: 'tracing',
      version: '1.0.0',
      type: 'accessory',
      description: 'x',
      targets: ['claude-code'],
    });
    expect(result.include.skills).toEqual([]);
    expect(result.include.rules).toEqual([]);
    expect(result.include.hooks).toEqual([]);
    expect(result.include.agents).toEqual([]);
    expect(result.include.commands).toEqual([]);
  });

  it('accepts a populated include block', () => {
    const result = AccessorySchema.safeParse({
      name: 'tracing',
      version: '1.0.0',
      type: 'accessory',
      description: 'x',
      targets: ['claude-code', 'codex', 'pi'],
      include: {
        skills: ['otel-conventions'],
        hooks: ['trace'],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.include.skills).toEqual(['otel-conventions']);
      expect(result.data.include.hooks).toEqual(['trace']);
      expect(result.data.include.rules).toEqual([]);
    }
  });

  it('rejects type other than "accessory"', () => {
    const result = AccessorySchema.safeParse({
      name: 'tracing',
      version: '1.0.0',
      type: 'outfit',
      description: 'x',
      targets: ['claude-code'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside include (strict)', () => {
    const result = AccessorySchema.safeParse({
      name: 'tracing',
      version: '1.0.0',
      type: 'accessory',
      description: 'x',
      targets: ['claude-code'],
      include: {
        skills: ['otel-conventions'],
        bogus: ['nope'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing required base fields', () => {
    const result = AccessorySchema.safeParse({
      name: 'tracing',
      type: 'accessory',
      description: 'x',
      targets: ['claude-code'],
      // version missing
    });
    expect(result.success).toBe(false);
  });
});

describe('findAccessory (3-tier discovery)', () => {
  it('finds an accessory in the user-scope dir', async () => {
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-user-'));
    await fs.mkdir(path.join(userDir, 'accessories'));
    await fs.writeFile(
      path.join(userDir, 'accessories', 'tracing.md'),
      `---
name: tracing
version: 1.0.0
type: accessory
description: t
targets: [claude-code]
include:
  skills: [otel-conventions]
---
`,
    );
    const result = await findAccessory('tracing', {
      projectDir: '/nonexistent',
      userDir,
      builtinDir: '/nonexistent',
    });
    expect(result.manifest.name).toBe('tracing');
    expect(result.source).toBe('user');
    expect(result.manifest.include.skills).toEqual(['otel-conventions']);
  });

  it('finds an accessory in the builtin-scope dir using accessory.md package layout', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-builtin-'));
    await fs.mkdir(path.join(builtinDir, 'accessories', 'tracing'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'accessories', 'tracing', 'accessory.md'),
      `---
name: tracing
version: 1.0.0
type: accessory
description: builtin
targets: [claude-code]
---
`,
    );
    const result = await findAccessory('tracing', {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
    });
    expect(result.manifest.name).toBe('tracing');
    expect(result.source).toBe('builtin');
  });

  it('project-scope wins over user-scope', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-proj-'));
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-user-'));
    await fs.mkdir(path.join(projectDir, '.suit', 'accessories'), { recursive: true });
    await fs.mkdir(path.join(userDir, 'accessories'));
    await fs.writeFile(
      path.join(projectDir, '.suit', 'accessories', 'tracing.md'),
      `---
name: tracing
version: 1.0.0
type: accessory
description: project
targets: [claude-code]
---
`,
    );
    await fs.writeFile(
      path.join(userDir, 'accessories', 'tracing.md'),
      `---
name: tracing
version: 1.0.0
type: accessory
description: user
targets: [claude-code]
---
`,
    );
    const result = await findAccessory('tracing', {
      projectDir,
      userDir,
      builtinDir: '/nonexistent',
    });
    expect(result.manifest.description).toBe('project');
    expect(result.source).toBe('project');
  });

  it('throws with a list of available names when not found', async () => {
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-user-'));
    await fs.mkdir(path.join(userDir, 'accessories'));
    await fs.writeFile(
      path.join(userDir, 'accessories', 'one.md'),
      `---
name: one
version: 1.0.0
type: accessory
description: t
targets: [claude-code]
---
`,
    );
    await expect(
      findAccessory('nope', {
        projectDir: '/nonexistent',
        userDir,
        builtinDir: '/nonexistent',
      }),
    ).rejects.toThrow(/not found.*one/);
  });
});

describe('listAllAccessories', () => {
  it('returns all accessories from all tiers, deduped by name with project winning', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-proj-'));
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-user-'));
    await fs.mkdir(path.join(projectDir, '.suit', 'accessories'), { recursive: true });
    await fs.mkdir(path.join(userDir, 'accessories'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.suit', 'accessories', 'shared.md'),
      `---
name: shared
version: 1.0.0
type: accessory
description: project-version
targets: [claude-code]
---
`,
    );
    await fs.writeFile(
      path.join(userDir, 'accessories', 'shared.md'),
      `---
name: shared
version: 1.0.0
type: accessory
description: user-version
targets: [claude-code]
---
`,
    );
    await fs.writeFile(
      path.join(userDir, 'accessories', 'only-user.md'),
      `---
name: only-user
version: 1.0.0
type: accessory
description: user-only
targets: [claude-code]
---
`,
    );
    const all = await listAllAccessories({
      projectDir,
      userDir,
      builtinDir: '/nonexistent',
    });
    expect(all.length).toBe(2);
    const shared = all.find((a) => a.manifest.name === 'shared')!;
    expect(shared.source).toBe('project');
    expect(shared.manifest.description).toBe('project-version');
    const onlyUser = all.find((a) => a.manifest.name === 'only-user')!;
    expect(onlyUser.source).toBe('user');
  });

  it('returns empty list when no accessories exist anywhere', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-empty-'));
    const all = await listAllAccessories({
      projectDir: tmp,
      userDir: tmp,
      builtinDir: tmp,
    });
    expect(all).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v0.6 accessory-as-role fall-through:
// `--accessory <name>` accepts any wardrobe component (skill/hook/rule/agent/
// command) and synthesizes a singleton wrapper accessory. Authored bundles
// under accessories/ still win when present.
// ---------------------------------------------------------------------------

async function writeBuiltinComponent(
  builtinDir: string,
  topDir: string,
  componentName: string,
  filename: string,
  manifestType: string,
): Promise<void> {
  const dir = path.join(builtinDir, topDir, componentName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, filename),
    `---
name: ${componentName}
version: 1.0.0
type: ${manifestType}
description: t
targets: [claude-code]
---
body
`,
  );
}

describe('findAccessory accessory-as-role fall-through', () => {
  it('synthesizes an accessory wrapping a skill when no accessory of that name exists', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-ft-skill-'));
    await writeBuiltinComponent(builtinDir, 'skills', 'tdd', 'SKILL.md', 'skill');
    const result = await findAccessory('tdd', {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
    });
    expect(result.synthetic).toBe(true);
    expect(result.manifest.name).toBe('tdd');
    expect(result.manifest.type).toBe('accessory');
    expect(result.manifest.include.skills).toEqual(['tdd']);
    expect(result.manifest.include.hooks).toEqual([]);
    expect(result.manifest.include.rules).toEqual([]);
    expect(result.manifest.include.agents).toEqual([]);
    expect(result.manifest.include.commands).toEqual([]);
    expect(result.manifest.categories).toEqual([]);
    expect(result.manifest.description).toMatch(/synthetic accessory.*skill.*tdd/);
  });

  it('synthesizes an accessory wrapping a hook', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-ft-hook-'));
    await writeBuiltinComponent(builtinDir, 'hooks', 'lint-on-save', 'HOOK.md', 'hook');
    const result = await findAccessory('lint-on-save', {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
    });
    expect(result.synthetic).toBe(true);
    expect(result.manifest.include.hooks).toEqual(['lint-on-save']);
    expect(result.manifest.include.skills).toEqual([]);
  });

  it('synthesizes an accessory wrapping a rule', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-ft-rule-'));
    await writeBuiltinComponent(builtinDir, 'rules', 'pr-policy', 'RULES.md', 'rules');
    const result = await findAccessory('pr-policy', {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
    });
    expect(result.synthetic).toBe(true);
    expect(result.manifest.include.rules).toEqual(['pr-policy']);
  });

  it('synthesizes an accessory wrapping an agent', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-ft-agent-'));
    await writeBuiltinComponent(builtinDir, 'agents', 'reviewer', 'AGENT.md', 'agent');
    const result = await findAccessory('reviewer', {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
    });
    expect(result.synthetic).toBe(true);
    expect(result.manifest.include.agents).toEqual(['reviewer']);
  });

  it('real accessory bundle wins over a same-named skill', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-ft-tie-'));
    // Write both: an authored accessory bundle AND a skill of the same name.
    await fs.mkdir(path.join(builtinDir, 'accessories', 'shared-name'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'accessories', 'shared-name', 'accessory.md'),
      `---
name: shared-name
version: 2.0.0
type: accessory
description: real-bundle
targets: [claude-code]
include:
  skills: [some-other-skill]
---
`,
    );
    await writeBuiltinComponent(builtinDir, 'skills', 'shared-name', 'SKILL.md', 'skill');
    const result = await findAccessory('shared-name', {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
    });
    expect(result.synthetic).toBe(false);
    expect(result.manifest.description).toBe('real-bundle');
    expect(result.manifest.version).toBe('2.0.0');
    expect(result.manifest.include.skills).toEqual(['some-other-skill']);
  });

  it('throws with a helpful error listing all locations searched when truly missing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-ft-miss-'));
    await expect(
      findAccessory('does-not-exist-anywhere', {
        projectDir: tmp,
        userDir: tmp,
        builtinDir: tmp,
      }),
    ).rejects.toThrow(/accessory\/skill\/hook\/rule\/agent\/command not found/);
  });

  it('listAllAccessories does not include synthetic accessories (only real bundles)', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-ft-list-'));
    // Only a skill exists — no real accessory bundles anywhere.
    await writeBuiltinComponent(builtinDir, 'skills', 'tdd', 'SKILL.md', 'skill');
    const all = await listAllAccessories({
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
    });
    expect(all).toEqual([]);
  });

  it('synthetic accessory contributes its singleton to the kept set in resolve()', async () => {
    // Build the same situation 2 ways:
    //   1) outfit.skill_include = ['tdd']
    //   2) --accessory tdd (synthesized)
    // Both should produce the same skillsDrop. We use a category-restricted
    // outfit so 'tdd' would otherwise be dropped — proving the force-include
    // path actually rescues it.
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-ft-resolve-'));
    await writeBuiltinComponent(builtinDir, 'skills', 'tdd', 'SKILL.md', 'skill');
    const found = await findAccessory('tdd', {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
    });
    expect(found.synthetic).toBe(true);

    const catalog: ComponentSource[] = [
      {
        relativeDir: 'skills/tdd',
        dir: '/tmp/skills/tdd',
        body: '',
        manifest: {
          name: 'tdd',
          version: '1.0.0',
          type: 'skill',
          description: '',
          targets: ['claude-code'],
          category: { primary: 'workflow' },
        } as any,
      },
      {
        relativeDir: 'skills/other',
        dir: '/tmp/skills/other',
        body: '',
        manifest: {
          name: 'other',
          version: '1.0.0',
          type: 'skill',
          description: '',
          targets: ['claude-code'],
          category: { primary: 'tooling' },
        } as any,
      },
    ];

    const outfitOnly = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: ['tdd'],
      skill_exclude: [],
    } as any;
    const viaSkillInclude = resolveSession({
      catalog,
      outfit: outfitOnly,
      harness: 'claude-code',
    });

    const outfitNoInclude = {
      name: 'p',
      type: 'outfit',
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any;
    const viaAccessory = resolveSession({
      catalog,
      outfit: outfitNoInclude,
      accessories: [found.manifest],
      harness: 'claude-code',
    });

    // Both paths keep 'tdd' (via outfit force-include in #1, via accessory
    // force-include in #2). Neither drops 'other' (it's in 'tooling' which
    // matches the outfit's categories).
    expect(viaSkillInclude.skillsDrop).not.toContain('tdd');
    expect(viaAccessory.skillsDrop).not.toContain('tdd');
    // And the kept-skills sets converge.
    expect(new Set(viaSkillInclude.skillsDrop)).toEqual(
      new Set(viaAccessory.skillsDrop),
    );
  });
});
