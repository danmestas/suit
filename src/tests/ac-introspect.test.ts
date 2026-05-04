import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listCommand, showCommand, doctorCommand } from '../lib/ac/introspect.ts';

describe('ac list', () => {
  it('lists all outfits', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-builtin-'));
    await fs.mkdir(path.join(builtinDir, 'outfits', 'one'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'outfits', 'one', 'outfit.md'),
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
    const out: string[] = [];
    await listCommand('outfits', {
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
  it('prints outfit details', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-show-'));
    await fs.mkdir(path.join(builtinDir, 'outfits', 'one'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'outfits', 'one', 'outfit.md'),
      `---
name: one
version: 1.0.0
type: outfit
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
    await showCommand({ kind: 'outfit', name: 'one' }, {
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

describe('ac list -v (verbose blurb)', () => {
  async function mkBuiltinWithOutfit(prefix: string, body: string): Promise<string> {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    await fs.mkdir(path.join(builtinDir, 'outfits', 'one'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'outfits', 'one', 'outfit.md'),
      `---
name: one
version: 1.0.0
type: outfit
description: short desc
targets: [claude-code]
categories: [tooling]
---
${body}`,
    );
    return builtinDir;
  }

  it('without -v, prints a single line per outfit (no blurb)', async () => {
    const builtinDir = await mkBuiltinWithOutfit(
      'ac-list-verb-off-',
      '\n# One\n\nThis is the body paragraph that should NOT appear.\n',
    );
    const out: string[] = [];
    await listCommand(
      'outfits',
      { projectDir: '/nonexistent', userDir: '/nonexistent', builtinDir, print: (l) => out.push(l) },
    );
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/^one\b/);
    expect(out.join('\n')).not.toMatch(/body paragraph/);
  });

  it('with -v, prints a blurb sub-line under each outfit', async () => {
    const builtinDir = await mkBuiltinWithOutfit(
      'ac-list-verb-on-',
      '\n# One\n\nBlurb-paragraph-text-marker for the verbose listing.\n',
    );
    const out: string[] = [];
    await listCommand(
      'outfits',
      { projectDir: '/nonexistent', userDir: '/nonexistent', builtinDir, print: (l) => out.push(l) },
      { verbose: true },
    );
    expect(out.length).toBe(2);
    expect(out[0]).toMatch(/^one\b/);
    expect(out[1]).toMatch(/Blurb-paragraph-text-marker/);
  });

  it('with -v but empty body, omits the sub-line (fallback equals description)', async () => {
    const builtinDir = await mkBuiltinWithOutfit('ac-list-verb-empty-', '\n');
    const out: string[] = [];
    await listCommand(
      'outfits',
      { projectDir: '/nonexistent', userDir: '/nonexistent', builtinDir, print: (l) => out.push(l) },
      { verbose: true },
    );
    // Body was empty → blurb falls back to description → we suppress the redundant sub-line.
    expect(out.length).toBe(1);
  });
});

describe('ac list accessories', () => {
  it('lists all accessories', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-builtin-acc-'));
    await fs.mkdir(path.join(builtinDir, 'accessories', 'tracing'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'accessories', 'tracing', 'accessory.md'),
      `---
name: tracing
version: 1.0.0
type: accessory
description: Add OpenTelemetry tracing
targets: [claude-code]
include:
  skills: [otel-conventions]
---
`,
    );
    const out: string[] = [];
    await listCommand('accessories', {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
      print: (line) => out.push(line),
    });
    const text = out.join('\n');
    expect(text).toMatch(/tracing/);
    expect(text).toMatch(/builtin/);
  });

  it('prints "(no accessories found)" when none are discoverable', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-none-'));
    const out: string[] = [];
    await listCommand('accessories', {
      projectDir: tmp,
      userDir: tmp,
      builtinDir: tmp,
      print: (line) => out.push(line),
    });
    expect(out).toEqual(['(no accessories found)']);
  });
});

describe('ac show accessory', () => {
  it('prints accessory details including the include block', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-show-acc-'));
    await fs.mkdir(path.join(builtinDir, 'accessories', 'tracing'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'accessories', 'tracing', 'accessory.md'),
      `---
name: tracing
version: 1.0.0
type: accessory
description: Add OpenTelemetry tracing context
targets: [claude-code, codex]
include:
  skills: [otel-conventions]
  hooks: [trace]
---
`,
    );
    const out: string[] = [];
    await showCommand({ kind: 'accessory', name: 'tracing' }, {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
      print: (l) => out.push(l),
    });
    const text = out.join('\n');
    expect(text).toMatch(/name: tracing/);
    expect(text).toMatch(/version: 1\.0\.0/);
    expect(text).toMatch(/include:/);
    expect(text).toMatch(/skills: otel-conventions/);
    expect(text).toMatch(/hooks: trace/);
  });

  it('prints body section when accessory has body content', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-show-acc-body-'));
    await fs.mkdir(path.join(builtinDir, 'accessories', 'tracing'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'accessories', 'tracing', 'accessory.md'),
      `---
name: tracing
version: 1.0.0
type: accessory
description: t
targets: [claude-code]
---

extra context body for accessory
`,
    );
    const out: string[] = [];
    await showCommand({ kind: 'accessory', name: 'tracing' }, {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
      print: (l) => out.push(l),
    });
    const text = out.join('\n');
    expect(text).toMatch(/--- body ---/);
    expect(text).toMatch(/extra context body for accessory/);
  });

  it('throws when name is missing', async () => {
    await expect(
      showCommand({ kind: 'accessory' }, {
        projectDir: '/nonexistent',
        userDir: '/nonexistent',
        builtinDir: '/nonexistent',
        print: () => {},
      }),
    ).rejects.toThrow(/name required/);
  });
});

describe('ac show mode (Phase 3 include block)', () => {
  it('prints the include: block when the mode declares one', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-show-mode-inc-'));
    await fs.mkdir(path.join(builtinDir, 'modes'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'modes', 'ticket-writing.md'),
      `---
name: ticket-writing
version: 1.0.0
type: mode
description: Ticket writing focus
targets: [claude-code]
categories: [workflow]
include:
  skills: [linear-method]
  hooks: [ticket-validator]
---

Body.
`,
    );
    const out: string[] = [];
    await showCommand({ kind: 'mode', name: 'ticket-writing' }, {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
      print: (l) => out.push(l),
    });
    const text = out.join('\n');
    expect(text).toMatch(/include:/);
    expect(text).toMatch(/skills: linear-method/);
    expect(text).toMatch(/hooks: ticket-validator/);
  });

  it('omits the include: block when the mode is body-only (back-compat)', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-show-mode-empty-'));
    await fs.mkdir(path.join(builtinDir, 'modes'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'modes', 'focused.md'),
      `---
name: focused
version: 1.0.0
type: mode
description: Single-task focus
targets: [claude-code]
categories: [tooling]
---

Body framing focused mode.
`,
    );
    const out: string[] = [];
    await showCommand({ kind: 'mode', name: 'focused' }, {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
      print: (l) => out.push(l),
    });
    const text = out.join('\n');
    // No `include:` header for body-only modes — keep v0.3 output stable.
    expect(text).not.toMatch(/^include:/m);
    // The mode prompt body section is still emitted.
    expect(text).toMatch(/--- mode prompt body/);
    expect(text).toMatch(/Body framing focused mode/);
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
