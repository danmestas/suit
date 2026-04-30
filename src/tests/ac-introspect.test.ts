import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listCommand, showCommand, doctorCommand } from '../lib/ac/introspect.ts';

describe('ac list', () => {
  it('lists all personas', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-builtin-'));
    await fs.mkdir(path.join(builtinDir, 'personas', 'one'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'personas', 'one', 'persona.md'),
      `---
name: one
version: 1.0.0
type: persona
description: t
targets: [claude-code]
categories: [tooling]
---
`,
    );
    const out: string[] = [];
    await listCommand('personas', {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
      print: (line) => out.push(line),
    });
    expect(out.some((l) => l.includes('one'))).toBe(true);
    expect(out.some((l) => l.includes('builtin'))).toBe(true);
  });
});

describe('ac show', () => {
  it('prints persona details', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-show-'));
    await fs.mkdir(path.join(builtinDir, 'personas', 'one'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'personas', 'one', 'persona.md'),
      `---
name: one
version: 1.0.0
type: persona
description: backend
targets: [claude-code]
categories: [tooling, workflow]
skill_include: [debugging]
skill_exclude: [frontend-design]
---

readme body
`,
    );
    const out: string[] = [];
    await showCommand({ kind: 'persona', name: 'one' }, {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
      print: (l) => out.push(l),
    });
    const text = out.join('\n');
    expect(text).toMatch(/categories:.*tooling.*workflow/);
    expect(text).toMatch(/skill_include:.*debugging/);
  });
});

describe('ac doctor', () => {
  it('reports binary missing for unknown bin names (now falls back to harness as bin)', async () => {
    const out: string[] = [];
    // Unknown harness now treated as bin name verbatim → not found → exit 1
    const code = await doctorCommand({
      harnesses: ['__nonexistent_harness_ac_test__'],
      print: (l) => out.push(l),
    });
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/✗.*__nonexistent_harness_ac_test__/);
  });

  it('returns 0 with no harnesses to check', async () => {
    const out: string[] = [];
    const code = await doctorCommand({
      harnesses: [],
      print: (l) => out.push(l),
    });
    expect(code).toBe(0);
  });

  it('formats ✓ / ✗ lines correctly', async () => {
    const out: string[] = [];
    const code = await doctorCommand({
      harnesses: ['pi'],
      print: (l) => out.push(l),
    });
    const text = out.join('\n');
    expect(text).toMatch(/pi/);
    // pi will not be on PATH in test env → ✗ + exit 1
    if (code !== 0) {
      expect(text).toMatch(/✗.*pi/);
    } else {
      expect(text).toMatch(/✓.*pi/);
    }
  });
});
