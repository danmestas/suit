import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { AccessorySchema } from '../lib/schema.ts';
import { findAccessory, listAllAccessories } from '../lib/accessory.ts';

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
    ).rejects.toThrow(/accessory not found.*one/);
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
