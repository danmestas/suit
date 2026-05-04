import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runUp } from '../../lib/ac/up.js';
import { readLockfile, sha256OfFile } from '../../lib/lockfile.js';

const cleanupQueue: string[] = [];
afterEach(async () => {
  while (cleanupQueue.length > 0) {
    const dir = cleanupQueue.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function mkdirT(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupQueue.push(dir);
  return dir;
}

/**
 * Build a minimal wardrobe content tree containing one outfit, one mode, one
 * accessory, and two skills. Targets default to `claude-code` so the
 * claude-code adapter is exercised.
 */
async function mkWardrobe(): Promise<string> {
  const root = await mkdirT('suit-wardrobe-');
  await fs.mkdir(path.join(root, 'outfits', 'backend'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'outfits', 'backend', 'outfit.md'),
    `---
name: backend
version: 1.0.0
type: outfit
description: Backend dev work
targets: [claude-code]
categories: [tooling]
---
backend body
`,
  );

  await fs.mkdir(path.join(root, 'modes', 'focused'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'modes', 'focused', 'mode.md'),
    `---
name: focused
version: 1.0.0
type: mode
description: deep focus
targets: [claude-code]
categories: [tooling]
---
focused body
`,
  );

  await fs.mkdir(path.join(root, 'accessories', 'axiom'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'accessories', 'axiom', 'accessory.md'),
    `---
name: axiom
version: 1.0.0
type: accessory
description: axiom telemetry
targets: [claude-code]
include:
  skills: []
---
axiom body
`,
  );

  await fs.mkdir(path.join(root, 'skills', 'kept'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'skills', 'kept', 'SKILL.md'),
    `---
name: kept
version: 1.0.0
type: skill
description: a kept skill
targets: [claude-code]
category:
  primary: tooling
---
kept body
`,
  );

  await fs.mkdir(path.join(root, 'skills', 'dropped'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'skills', 'dropped', 'SKILL.md'),
    `---
name: dropped
version: 1.0.0
type: skill
description: a dropped skill
targets: [claude-code]
category:
  primary: workflow
---
dropped body
`,
  );

  return root;
}

async function mkProject(): Promise<string> {
  return await mkdirT('suit-up-proj-');
}

interface Capture {
  out: string[];
  err: string[];
  push: (s: string) => void;
  pushE: (s: string) => void;
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    push: (s) => out.push(s),
    pushE: (s) => err.push(s),
  };
}

describe('runUp — basic apply', () => {
  it('writes files and a lockfile when applying to a fresh project', async () => {
    const wardrobe = await mkWardrobe();
    const proj = await mkProject();
    const userDir = await mkdirT('suit-up-user-');
    const cap = capture();

    const code = await runUp(
      {
        outfit: 'backend',
        mode: 'focused',
        accessories: [],
        force: false,
        projectDir: proj,
        contentDir: wardrobe,
        userDir,
        isTTY: false,
      },
      { stdout: cap.push, stderr: cap.pushE },
    );

    expect(cap.err.join('')).toBe('');
    expect(code).toBe(0);

    // Lockfile exists with the expected resolution.
    const lock = await readLockfile(proj);
    expect(lock).not.toBeNull();
    expect(lock!.resolution).toEqual({
      outfit: 'backend',
      mode: 'focused',
      accessories: [],
    });
    expect(lock!.files.length).toBeGreaterThan(0);

    // Each tracked file exists on disk and its sha256 matches the lockfile.
    for (const f of lock!.files) {
      const full = path.join(proj, f.path);
      const stat = await fs.stat(full);
      expect(stat.isFile()).toBe(true);
      const sha = await sha256OfFile(full);
      expect(sha).toBe(f.sha256);
    }

    // The kept skill is present, the dropped skill is not.
    expect(lock!.files.some((f) => f.path.endsWith('skills/kept/SKILL.md'))).toBe(true);
    expect(lock!.files.some((f) => f.path.endsWith('skills/dropped/SKILL.md'))).toBe(false);

    // Stdout reports applied resolution and lockfile path.
    const out = cap.out.join('');
    expect(out).toMatch(/outfit=backend/);
    expect(out).toMatch(/mode=focused/);
    expect(out).toMatch(/Lockfile:/);
  });

  it('refuses when a target file exists and is not suit-managed', async () => {
    const wardrobe = await mkWardrobe();
    const proj = await mkProject();
    const userDir = await mkdirT('suit-up-user-');

    // Pre-create a file at one of the paths the claude-code adapter will emit.
    await fs.mkdir(path.join(proj, '.claude', 'skills', 'kept'), { recursive: true });
    await fs.writeFile(
      path.join(proj, '.claude', 'skills', 'kept', 'SKILL.md'),
      'hand-authored',
    );

    const cap = capture();
    const code = await runUp(
      {
        outfit: 'backend',
        mode: null,
        accessories: [],
        force: false,
        projectDir: proj,
        contentDir: wardrobe,
        userDir,
        isTTY: false,
      },
      { stdout: cap.push, stderr: cap.pushE },
    );

    expect(code).toBe(1);
    expect(cap.err.join('')).toMatch(/not suit-managed/);
    // Lockfile should NOT exist on a refused apply.
    expect(await readLockfile(proj)).toBeNull();
  });

  it('refuses when prior lockfile records different resolution', async () => {
    const wardrobe = await mkWardrobe();
    const proj = await mkProject();
    const userDir = await mkdirT('suit-up-user-');

    // First apply: outfit=backend, mode=focused.
    const c1 = capture();
    await runUp(
      {
        outfit: 'backend',
        mode: 'focused',
        accessories: [],
        force: false,
        projectDir: proj,
        contentDir: wardrobe,
        userDir,
        isTTY: false,
      },
      { stdout: c1.push, stderr: c1.pushE },
    );
    expect(await readLockfile(proj)).not.toBeNull();

    // Second apply: same outfit, no mode → different resolution.
    const c2 = capture();
    const code = await runUp(
      {
        outfit: 'backend',
        mode: null,
        accessories: [],
        force: false,
        projectDir: proj,
        contentDir: wardrobe,
        userDir,
        isTTY: false,
      },
      { stdout: c2.push, stderr: c2.pushE },
    );

    expect(code).toBe(1);
    expect(c2.err.join('')).toMatch(/already dressed/);
  });

  it('--force overrides hand-authored target file', async () => {
    const wardrobe = await mkWardrobe();
    const proj = await mkProject();
    const userDir = await mkdirT('suit-up-user-');

    await fs.mkdir(path.join(proj, '.claude', 'skills', 'kept'), { recursive: true });
    await fs.writeFile(
      path.join(proj, '.claude', 'skills', 'kept', 'SKILL.md'),
      'hand-authored',
    );

    const cap = capture();
    const code = await runUp(
      {
        outfit: 'backend',
        mode: null,
        accessories: [],
        force: true,
        projectDir: proj,
        contentDir: wardrobe,
        userDir,
        isTTY: false,
      },
      { stdout: cap.push, stderr: cap.pushE },
    );

    expect(cap.err.join('')).toBe('');
    expect(code).toBe(0);
    const lock = await readLockfile(proj);
    expect(lock).not.toBeNull();
    expect(
      lock!.files.some((f) => f.path === '.claude/skills/kept/SKILL.md'),
    ).toBe(true);
  });

  it('--force overrides prior lockfile resolution mismatch', async () => {
    const wardrobe = await mkWardrobe();
    const proj = await mkProject();
    const userDir = await mkdirT('suit-up-user-');

    const c1 = capture();
    await runUp(
      {
        outfit: 'backend',
        mode: 'focused',
        accessories: [],
        force: false,
        projectDir: proj,
        contentDir: wardrobe,
        userDir,
        isTTY: false,
      },
      { stdout: c1.push, stderr: c1.pushE },
    );

    const c2 = capture();
    const code = await runUp(
      {
        outfit: 'backend',
        mode: null,
        accessories: [],
        force: true,
        projectDir: proj,
        contentDir: wardrobe,
        userDir,
        isTTY: false,
      },
      { stdout: c2.push, stderr: c2.pushE },
    );

    expect(code).toBe(0);
    const lock = await readLockfile(proj);
    expect(lock!.resolution.mode).toBeNull();
  });

  it('re-applying the same resolution is idempotent', async () => {
    const wardrobe = await mkWardrobe();
    const proj = await mkProject();
    const userDir = await mkdirT('suit-up-user-');

    const c1 = capture();
    await runUp(
      {
        outfit: 'backend',
        mode: 'focused',
        accessories: [],
        force: false,
        projectDir: proj,
        contentDir: wardrobe,
        userDir,
        isTTY: false,
      },
      { stdout: c1.push, stderr: c1.pushE },
    );
    const lock1 = await readLockfile(proj);
    const ts1 = lock1!.appliedAt;
    const file1Sha = lock1!.files[0].sha256;

    // Wait a millisecond to ensure ISO timestamps differ.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const c2 = capture();
    const code = await runUp(
      {
        outfit: 'backend',
        mode: 'focused',
        accessories: [],
        force: false,
        projectDir: proj,
        contentDir: wardrobe,
        userDir,
        isTTY: false,
      },
      { stdout: c2.push, stderr: c2.pushE },
    );

    expect(c2.err.join('')).toBe('');
    expect(code).toBe(0);
    const lock2 = await readLockfile(proj);
    expect(lock2!.appliedAt).not.toBe(ts1);
    // File set unchanged.
    expect(lock2!.files.length).toBe(lock1!.files.length);
    expect(lock2!.files[0].sha256).toBe(file1Sha);
  });

  it('propagates strict-include error from resolve()', async () => {
    const wardrobe = await mkWardrobe();
    const proj = await mkProject();
    const userDir = await mkdirT('suit-up-user-');

    // Add a mode that includes a non-existent skill — resolve() should refuse.
    await fs.mkdir(path.join(wardrobe, 'modes', 'broken'), { recursive: true });
    await fs.writeFile(
      path.join(wardrobe, 'modes', 'broken', 'mode.md'),
      `---
name: broken
version: 1.0.0
type: mode
description: invalid include
targets: [claude-code]
categories: []
include:
  skills: [nonexistent-skill]
---
broken body
`,
    );

    const cap = capture();
    let threw = false;
    try {
      await runUp(
        {
          outfit: 'backend',
          mode: 'broken',
          accessories: [],
          force: false,
          projectDir: proj,
          contentDir: wardrobe,
          userDir,
          isTTY: false,
        },
        { stdout: cap.push, stderr: cap.pushE },
      );
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/nonexistent-skill/);
    }
    expect(threw).toBe(true);
  });

  it('non-TTY missing --outfit errors with the expected message', async () => {
    const wardrobe = await mkWardrobe();
    const proj = await mkProject();
    const userDir = await mkdirT('suit-up-user-');

    const cap = capture();
    const code = await runUp(
      {
        outfit: null,
        mode: null,
        accessories: [],
        force: false,
        projectDir: proj,
        contentDir: wardrobe,
        userDir,
        isTTY: false,
      },
      { stdout: cap.push, stderr: cap.pushE },
    );

    expect(code).toBe(2);
    expect(cap.err.join('')).toMatch(/--outfit is required/);
  });

  it('TTY missing --outfit prints the picker-not-implemented stub and exits 2', async () => {
    const wardrobe = await mkWardrobe();
    const proj = await mkProject();
    const userDir = await mkdirT('suit-up-user-');

    const cap = capture();
    const code = await runUp(
      {
        outfit: null,
        mode: null,
        accessories: [],
        force: false,
        projectDir: proj,
        contentDir: wardrobe,
        userDir,
        isTTY: true,
      },
      { stdout: cap.push, stderr: cap.pushE },
    );

    expect(code).toBe(2);
    expect(cap.err.join('')).toMatch(/picker not yet implemented/);
  });
});
