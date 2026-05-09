import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPrepare } from '../../lib/ac/prepare.js';
import { LOCKFILE_PATH } from '../../lib/lockfile.js';

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
 * Minimal wardrobe with one outfit + one rules component, both targeting
 * claude-code. Mirrors the up.test.ts shape but small enough to run fast.
 */
async function mkWardrobe(): Promise<string> {
  const root = await mkdirT('suit-prepare-wardrobe-');
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
  await fs.mkdir(path.join(root, 'rules', 'safety'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'rules', 'safety', 'RULE.md'),
    `---
name: safety
version: 1.0.0
type: rules
description: project-scope safety rules
targets: [claude-code]
scope: project
---
do not push to main without review
`,
  );
  return root;
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
  return { out, err, push: (s) => out.push(s), pushE: (s) => err.push(s) };
}

describe('runPrepare', () => {
  it('emits a bundle to a fresh tempdir and prints its path on stdout', async () => {
    const wardrobe = await mkWardrobe();
    const projectDir = await mkdirT('suit-prepare-proj-');
    const userDir = await mkdirT('suit-prepare-user-');
    const cap = capture();

    const code = await runPrepare(
      {
        outfit: 'backend',
        cut: null,
        accessories: [],
        target: 'claude-code',
        projectDir,
        contentDir: wardrobe,
        userDir,
      },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(code).toBe(0);
    expect(cap.err.join('')).toBe('');

    // Stdout payload is exactly one line — the bundle path. Machine-friendly.
    const stdout = cap.out.join('');
    expect(stdout.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
    const bundle = stdout.trim();
    expect(bundle.startsWith(os.tmpdir())).toBe(true);
    expect(bundle).toMatch(/suit-prepare-/);
    cleanupQueue.push(bundle);

    // Bundle has the expected dressing — claude-code's CLAUDE.md (additive
    // outfit-body block) plus the rules-emitted root CLAUDE.md.
    expect(await fs.stat(path.join(bundle, '.claude', 'CLAUDE.md'))).toBeDefined();
    expect(await fs.stat(path.join(bundle, 'CLAUDE.md'))).toBeDefined();
    const rootClaude = await fs.readFile(path.join(bundle, 'CLAUDE.md'), 'utf8');
    expect(rootClaude).toMatch(/<!-- suit:outfit:backend -->/);
  });

  it('does not write a lockfile or touch the project tree', async () => {
    const wardrobe = await mkWardrobe();
    const projectDir = await mkdirT('suit-prepare-proj-');
    const userDir = await mkdirT('suit-prepare-user-');
    const cap = capture();

    await runPrepare(
      {
        outfit: 'backend',
        cut: null,
        accessories: [],
        target: 'claude-code',
        projectDir,
        contentDir: wardrobe,
        userDir,
      },
      { stdout: cap.push, stderr: cap.pushE },
    );

    // The project tree must remain untouched — no lockfile, no .claude/, etc.
    const projectEntries = await fs.readdir(projectDir);
    expect(projectEntries).toEqual([]);
    let lockExists = false;
    try {
      await fs.stat(path.join(projectDir, LOCKFILE_PATH));
      lockExists = true;
    } catch {
      lockExists = false;
    }
    expect(lockExists).toBe(false);

    cleanupQueue.push(cap.out.join('').trim());
  });

  it('rejects an unknown --target with exit 2 and a known-targets list', async () => {
    const wardrobe = await mkWardrobe();
    const projectDir = await mkdirT('suit-prepare-proj-');
    const userDir = await mkdirT('suit-prepare-user-');
    const cap = capture();

    const code = await runPrepare(
      {
        outfit: 'backend',
        cut: null,
        accessories: [],
        // Cast around the type guard — runPrepare itself validates at runtime
        // even when the CLI parser would reject earlier.
        target: 'nope' as 'claude-code',
        projectDir,
        contentDir: wardrobe,
        userDir,
      },
      { stdout: cap.push, stderr: cap.pushE },
    );

    expect(code).toBe(2);
    expect(cap.err.join('')).toMatch(/unknown --target/);
    expect(cap.err.join('')).toMatch(/known: /);
  });

  it('exits 1 with a friendly error when the resolved bundle has zero files for the target', async () => {
    // Wardrobe declares only claude-code; ask for codex, which the outfit
    // doesn't target. Composing yields an empty pending list — surface that
    // loud rather than silently writing an empty bundle.
    const wardrobe = await mkWardrobe();
    const projectDir = await mkdirT('suit-prepare-proj-');
    const userDir = await mkdirT('suit-prepare-user-');
    const cap = capture();

    const code = await runPrepare(
      {
        outfit: 'backend',
        cut: null,
        accessories: [],
        target: 'codex',
        projectDir,
        contentDir: wardrobe,
        userDir,
      },
      { stdout: cap.push, stderr: cap.pushE },
    );

    expect(code).toBe(1);
    expect(cap.err.join('')).toMatch(/nothing to emit/);
  });

  it('does not clean up the tempdir — caller owns its lifetime', async () => {
    const wardrobe = await mkWardrobe();
    const projectDir = await mkdirT('suit-prepare-proj-');
    const userDir = await mkdirT('suit-prepare-user-');
    const cap = capture();

    await runPrepare(
      {
        outfit: 'backend',
        cut: null,
        accessories: [],
        target: 'claude-code',
        projectDir,
        contentDir: wardrobe,
        userDir,
      },
      { stdout: cap.push, stderr: cap.pushE },
    );
    const bundle = cap.out.join('').trim();
    cleanupQueue.push(bundle);

    // After runPrepare returns, the tempdir is still on disk with content —
    // the caller decides when to remove it.
    const stat = await fs.stat(bundle);
    expect(stat.isDirectory()).toBe(true);
    const entries = await fs.readdir(bundle);
    expect(entries.length).toBeGreaterThan(0);
  });
});
