import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ModeSchema } from '../lib/schema.ts';
import { findMode } from '../lib/mode.ts';

describe('ModeSchema', () => {
  it('accepts a minimal valid mode', () => {
    const result = ModeSchema.safeParse({
      name: 'focused',
      version: '1.0.0',
      type: 'mode',
      description: 'Single-task focus',
      targets: ['claude-code'],
      categories: ['tooling'],
    });
    expect(result.success).toBe(true);
  });

  it('defaults skill_include and skill_exclude to empty arrays', () => {
    const result = ModeSchema.parse({
      name: 'focused',
      version: '1.0.0',
      type: 'mode',
      description: 'x',
      targets: ['claude-code'],
      categories: ['tooling'],
    });
    expect(result.skill_include).toEqual([]);
    expect(result.skill_exclude).toEqual([]);
  });

  it('rejects type other than "mode"', () => {
    const result = ModeSchema.safeParse({
      name: 'focused',
      version: '1.0.0',
      type: 'outfit',
      description: 'x',
      targets: ['claude-code'],
      categories: ['tooling'],
    });
    expect(result.success).toBe(false);
  });

  it('defaults all 5 include sub-arrays to empty when no include block is declared (back-compat)', () => {
    const result = ModeSchema.parse({
      name: 'focused',
      version: '1.0.0',
      type: 'mode',
      description: 'x',
      targets: ['claude-code'],
      categories: ['tooling'],
    });
    expect(result.include.skills).toEqual([]);
    expect(result.include.rules).toEqual([]);
    expect(result.include.hooks).toEqual([]);
    expect(result.include.agents).toEqual([]);
    expect(result.include.commands).toEqual([]);
  });

  it('accepts a populated include block on a mode', () => {
    const result = ModeSchema.safeParse({
      name: 'ticket-writing',
      version: '1.0.0',
      type: 'mode',
      description: 'x',
      targets: ['claude-code'],
      categories: ['workflow'],
      include: {
        skills: ['linear-method'],
        hooks: ['ticket-validator'],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.include.skills).toEqual(['linear-method']);
      expect(result.data.include.hooks).toEqual(['ticket-validator']);
      expect(result.data.include.rules).toEqual([]);
    }
  });

  it('rejects unknown keys inside mode include (strict)', () => {
    const result = ModeSchema.safeParse({
      name: 'focused',
      version: '1.0.0',
      type: 'mode',
      description: 'x',
      targets: ['claude-code'],
      categories: ['tooling'],
      include: {
        skills: ['idiomatic-go'],
        bogus: ['nope'],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('findMode', () => {
  it('finds a mode in user-scope dir and parses the body', async () => {
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-user-'));
    await fs.mkdir(path.join(userDir, 'modes'));
    await fs.writeFile(
      path.join(userDir, 'modes', 'focused.md'),
      `---
name: focused
version: 1.0.0
type: mode
description: focus
targets: [claude-code]
categories: [tooling]
---

You are in focused mode.
`,
    );
    const result = await findMode('focused', {
      projectDir: '/nonexistent',
      userDir,
      builtinDir: '/nonexistent',
    });
    expect(result.body.trim()).toBe('You are in focused mode.');
  });
});
