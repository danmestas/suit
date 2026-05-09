import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listCommand, showCommand } from '../lib/ac/introspect.ts';
import { runDoctor } from '../lib/ac/doctor.ts';

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

describe('ac show cut (include block)', () => {
  it('prints the include: block when the cut declares one', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-show-cut-inc-'));
    await fs.mkdir(path.join(builtinDir, 'cuts'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'cuts', 'ticket-writing.md'),
      `---
name: ticket-writing
version: 1.0.0
type: cut
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
    await showCommand({ kind: 'cut', name: 'ticket-writing' }, {
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

  it('omits the include: block when the cut is body-only (back-compat)', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-show-cut-empty-'));
    await fs.mkdir(path.join(builtinDir, 'cuts'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'cuts', 'focused.md'),
      `---
name: focused
version: 1.0.0
type: cut
description: Single-task focus
targets: [claude-code]
categories: [tooling]
---

Body framing focused cut.
`,
    );
    const out: string[] = [];
    await showCommand({ kind: 'cut', name: 'focused' }, {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir,
      print: (l) => out.push(l),
    });
    const text = out.join('\n');
    // No `include:` header for body-only cuts — keep v0.3-era output stable.
    expect(text).not.toMatch(/^include:/m);
    // The cut prompt body section is still emitted.
    expect(text).toMatch(/--- cut prompt body/);
    expect(text).toMatch(/Body framing focused cut/);
  });
});

describe('ac doctor', () => {
  // Standard "minimal valid" deps shape: a tempdir for content/project/user
  // so checks have somewhere to look. Tests override individual fields to
  // exercise specific behaviors.
  async function mkDoctorDeps(harnesses: string[]): Promise<{
    deps: Parameters<typeof runDoctor>[0];
    out: string[];
    cleanup: () => Promise<void>;
  }> {
    const out: string[] = [];
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-proj-'));
    const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-user-'));
    const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-content-'));
    return {
      deps: {
        projectDir,
        userDir,
        contentDir,
        harnesses,
        print: (l: string) => out.push(l),
      },
      out,
      cleanup: async () => {
        await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(userDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(contentDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  it('reports ✗ + exit 1 for missing harness binaries', async () => {
    const { deps, out, cleanup } = await mkDoctorDeps(['__nonexistent_harness_ac_test__']);
    try {
      const code = await runDoctor(deps);
      expect(code).toBe(1);
      expect(out.join('\n')).toMatch(/✗\s+harness: __nonexistent_harness_ac_test__/);
    } finally {
      await cleanup();
    }
  });

  it('exit 0 when no harnesses requested and other checks pass', async () => {
    const { deps, cleanup } = await mkDoctorDeps([]);
    try {
      const code = await runDoctor(deps);
      expect(code).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('reports ✓ for the content path when it exists', async () => {
    const { deps, out, cleanup } = await mkDoctorDeps([]);
    try {
      await runDoctor(deps);
      expect(out.join('\n')).toMatch(/✓\s+content path\s+/);
    } finally {
      await cleanup();
    }
  });

  it('reports ✗ for the content path when missing', async () => {
    const { deps, out, cleanup } = await mkDoctorDeps([]);
    try {
      // Override contentDir to a path that doesn't exist.
      deps.contentDir = '/nonexistent/path/for/doctor-test';
      const code = await runDoctor(deps);
      expect(code).toBe(1);
      expect(out.join('\n')).toMatch(/✗\s+content path\s+/);
      expect(out.join('\n')).toMatch(/does not exist/);
    } finally {
      await cleanup();
    }
  });

  it('reports drift when ~/.claude.json is newer than wardrobe globals.yaml', async () => {
    const { deps, out, cleanup } = await mkDoctorDeps([]);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-home-'));
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // globals.yaml: old
      const globalsPath = path.join(deps.contentDir, 'globals.yaml');
      await fs.writeFile(globalsPath, 'schemaVersion: 1\nplugins: {}\nmcps: {}\nhooks: {}\n');
      const past = new Date(Date.now() - 30 * 86400000);
      await fs.utimes(globalsPath, past, past);

      // ~/.claude.json: now
      await fs.writeFile(path.join(fakeHome, '.claude.json'), '{}\n');

      await runDoctor(deps);
      expect(out.join('\n')).toMatch(/⚠\s+globals \(claude\)\s+drift/);
    } finally {
      process.env.HOME = realHome;
      await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => {});
      await cleanup();
    }
  });

  it('skips the globals check when wardrobe has no globals.yaml', async () => {
    const { deps, out, cleanup } = await mkDoctorDeps([]);
    try {
      await runDoctor(deps);
      expect(out.join('\n')).toMatch(/✓\s+globals \(claude\)\s+no globals.yaml/);
    } finally {
      await cleanup();
    }
  });

  it('reports lockfile consistency when all recorded paths exist', async () => {
    const { deps, out, cleanup } = await mkDoctorDeps([]);
    try {
      // Synthesize a lockfile with one entry pointing at a real file.
      await fs.mkdir(path.join(deps.projectDir, '.suit'), { recursive: true });
      await fs.writeFile(path.join(deps.projectDir, 'CLAUDE.md'), 'test\n');
      await fs.writeFile(
        path.join(deps.projectDir, '.suit', 'lock.json'),
        JSON.stringify({
          schemaVersion: 1,
          appliedAt: new Date().toISOString(),
          resolution: { outfit: 'backend', cut: null, accessories: [], targets: ['claude-code'] },
          files: [
            {
              path: 'CLAUDE.md',
              sha256: '0'.repeat(64),
              mode: 'replace',
              sourceComponent: 'outfits/backend',
            },
          ],
        }),
      );
      await runDoctor(deps);
      expect(out.join('\n')).toMatch(/✓\s+lockfile\s+consistent/);
    } finally {
      await cleanup();
    }
  });

  it('returns exit 1 when summary mentions any failures', async () => {
    const { deps, out, cleanup } = await mkDoctorDeps(['__nonexistent_harness_doc_test__']);
    try {
      const code = await runDoctor(deps);
      expect(code).toBe(1);
      // Trailer line includes failure count.
      expect(out.join('\n')).toMatch(/1 failure/);
    } finally {
      await cleanup();
    }
  });
});

describe('ac list accessories --resolvable', () => {
  async function mkResolvableWardrobe(prefix: string): Promise<string> {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));

    // Authored accessory `philosophy` — the canonical type.
    await fs.mkdir(path.join(builtinDir, 'accessories', 'philosophy'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'accessories', 'philosophy', 'accessory.md'),
      `---
name: philosophy
type: accessory
description: a real authored accessory
targets: [claude-code]
---
philosophy body
`,
    );

    // Synthetic-source skill `tdd` — fall-through target.
    await fs.mkdir(path.join(builtinDir, 'skills', 'tdd'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'skills', 'tdd', 'SKILL.md'),
      `---
name: tdd
type: skill
description: test driven development
targets: [claude-code]
categories: [discipline]
---
tdd body
`,
    );

    // Synthetic-source rule `pr-policy` — fall-through target.
    await fs.mkdir(path.join(builtinDir, 'rules', 'pr-policy'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'rules', 'pr-policy', 'RULE.md'),
      `---
name: pr-policy
type: rules
description: pr policy rule
targets: [claude-code]
scope: project
---
pr-policy body
`,
    );

    return builtinDir;
  }

  it('flat list unions accessories + fall-through targets with kind annotations', async () => {
    const builtinDir = await mkResolvableWardrobe('ac-resolvable-');
    const out: string[] = [];
    await listCommand(
      'accessories',
      { projectDir: '/nonexistent', userDir: '/nonexistent', builtinDir, print: (l) => out.push(l) },
      { resolvable: true },
    );

    const text = out.join('\n');
    expect(text).toMatch(/philosophy\s+\[accessory\]\s+\(builtin\)/);
    expect(text).toMatch(/tdd\s+\[skill\]\s+\(builtin\)/);
    expect(text).toMatch(/pr-policy\s+\[rule\]\s+\(builtin\)/);

    // No two-section split (no "authored:" / "synthetic:" headers).
    expect(text).not.toMatch(/authored:/i);
    expect(text).not.toMatch(/synthetic:/i);

    // Sorted alphabetically.
    const names = out.map((l) => l.split(/\s+/)[0]);
    expect(names).toEqual([...names].sort());
  });

  it('without --resolvable, only authored accessories listed', async () => {
    const builtinDir = await mkResolvableWardrobe('ac-resolvable-default-');
    const out: string[] = [];
    await listCommand(
      'accessories',
      { projectDir: '/nonexistent', userDir: '/nonexistent', builtinDir, print: (l) => out.push(l) },
    );

    const text = out.join('\n');
    expect(text).toMatch(/philosophy/);
    expect(text).not.toMatch(/\btdd\b/);
    expect(text).not.toMatch(/pr-policy/);
  });

  it('on name collision, authored accessory wins over fall-through (annotated [accessory])', async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-resolvable-collide-'));

    // Both an authored accessory AND a skill named `same`.
    await fs.mkdir(path.join(builtinDir, 'accessories', 'same'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'accessories', 'same', 'accessory.md'),
      `---
name: same
type: accessory
description: authored bundle
targets: [claude-code]
---
authored body
`,
    );
    await fs.mkdir(path.join(builtinDir, 'skills', 'same'), { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, 'skills', 'same', 'SKILL.md'),
      `---
name: same
type: skill
description: shadowed skill
targets: [claude-code]
categories: [tooling]
---
shadowed body
`,
    );

    const out: string[] = [];
    await listCommand(
      'accessories',
      { projectDir: '/nonexistent', userDir: '/nonexistent', builtinDir, print: (l) => out.push(l) },
      { resolvable: true },
    );

    // Single row; kind is [accessory] (authored wins).
    expect(out.filter((l) => l.startsWith('same')).length).toBe(1);
    expect(out.find((l) => l.startsWith('same'))).toMatch(/\[accessory\]/);
  });
});
