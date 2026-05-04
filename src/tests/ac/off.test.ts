import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOff } from '../../lib/ac/off.js';
import {
  LOCKFILE_PATH,
  readLockfile,
  writeLockfile,
  sha256OfBuffer,
  type Lockfile,
} from '../../lib/lockfile.js';

const cleanupQueue: string[] = [];
afterEach(async () => {
  while (cleanupQueue.length > 0) {
    const dir = cleanupQueue.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function mkProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suit-off-'));
  cleanupQueue.push(dir);
  return dir;
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

/**
 * Materialize a file at `projectDir/<rel>` with the given body and return a
 * matching LockEntry. The lockfile sha256 is computed from `body`, so the file
 * is in-sync by default; tests that want drift overwrite the file afterward.
 */
async function plant(
  projectDir: string,
  rel: string,
  body: string,
  sourceComponent = 'skills/test',
): Promise<{ path: string; sha256: string; sourceComponent: string }> {
  const full = path.join(projectDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
  return { path: rel, sha256: sha256OfBuffer(body), sourceComponent };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('runOff — idempotent / no lockfile', () => {
  it('exits 0 with a friendly message when no lockfile is present', async () => {
    const proj = await mkProject();
    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(code).toBe(0);
    expect(cap.err.join('')).toBe('');
    expect(cap.out.join('')).toMatch(/no suit applied/);
  });
});

describe('runOff — happy path', () => {
  it('removes all tracked files, the lockfile, and now-empty parent dirs', async () => {
    const proj = await mkProject();
    const e1 = await plant(proj, '.claude/skills/idiomatic-go/SKILL.md', 'go body\n');
    const e2 = await plant(proj, '.claude/CLAUDE.md', '# rules\n');
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: 'backend', mode: null, accessories: [] },
      files: [e1, e2],
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(cap.err.join('')).toBe('');
    expect(code).toBe(0);

    // Files gone.
    expect(await fileExists(path.join(proj, e1.path))).toBe(false);
    expect(await fileExists(path.join(proj, e2.path))).toBe(false);

    // Empty parent dirs cleaned up.
    expect(await fileExists(path.join(proj, '.claude/skills/idiomatic-go'))).toBe(false);
    expect(await fileExists(path.join(proj, '.claude/skills'))).toBe(false);
    expect(await fileExists(path.join(proj, '.claude'))).toBe(false);

    // Lockfile + .suit dir gone.
    expect(await readLockfile(proj)).toBeNull();
    expect(await fileExists(path.join(proj, '.suit'))).toBe(false);

    // Report shape.
    const out = cap.out.join('');
    expect(out).toMatch(/Removed 2 files/);
    expect(out).toMatch(/Removed lockfile:/);
  });
});

describe('runOff — file missing on disk', () => {
  it('skips silently when a tracked file is already gone', async () => {
    const proj = await mkProject();
    const present = await plant(proj, '.claude/skills/a/SKILL.md', 'present\n');
    // Tracked but never materialized — simulates a half-gone state.
    const ghostBody = 'never materialized\n';
    const ghost = {
      path: '.claude/skills/b/SKILL.md',
      sha256: sha256OfBuffer(ghostBody),
      sourceComponent: 'skills/b',
    };

    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: 'backend', mode: null, accessories: [] },
      files: [present, ghost],
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(code).toBe(0);
    expect(cap.err.join('')).toBe('');

    const out = cap.out.join('');
    expect(out).toMatch(/Removed 1 file/);
    expect(out).toMatch(/Skipped 1 already-missing file/);

    // The materialized file is gone, lockfile is gone.
    expect(await fileExists(path.join(proj, present.path))).toBe(false);
    expect(await readLockfile(proj)).toBeNull();
  });
});

describe('runOff — drift refusal', () => {
  it('refuses without --force and lists ALL hand-edited files in one shot', async () => {
    const proj = await mkProject();
    const e1 = await plant(proj, '.claude/skills/a/SKILL.md', 'a-original\n');
    const e2 = await plant(proj, '.claude/skills/b/SKILL.md', 'b-original\n');
    const e3 = await plant(proj, '.claude/skills/c/SKILL.md', 'c-original\n');
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: 'backend', mode: null, accessories: [] },
      files: [e1, e2, e3],
    };
    await writeLockfile(proj, lock);

    // Hand-edit two of the three.
    await fs.writeFile(path.join(proj, e1.path), 'a-edited\n');
    await fs.writeFile(path.join(proj, e3.path), 'c-edited\n');

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(code).toBe(1);

    const err = cap.err.join('');
    // Both drifted paths are reported.
    expect(err).toMatch(/hand-edited since suit applied it: \.claude\/skills\/a\/SKILL\.md/);
    expect(err).toMatch(/hand-edited since suit applied it: \.claude\/skills\/c\/SKILL\.md/);
    // The clean file is NOT listed.
    expect(err).not.toMatch(/skills\/b\/SKILL\.md/);
    // Summary line counts both refusals.
    expect(err).toMatch(/refusing to delete 2 hand-edited files/);

    // Nothing was deleted.
    expect(await fileExists(path.join(proj, e1.path))).toBe(true);
    expect(await fileExists(path.join(proj, e2.path))).toBe(true);
    expect(await fileExists(path.join(proj, e3.path))).toBe(true);
    expect(await readLockfile(proj)).not.toBeNull();
  });
});

describe('runOff — --force', () => {
  it('removes hand-edited files and reports them in the summary', async () => {
    const proj = await mkProject();
    const e1 = await plant(proj, '.claude/skills/a/SKILL.md', 'a-original\n');
    const e2 = await plant(proj, '.claude/skills/b/SKILL.md', 'b-original\n');
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: 'backend', mode: null, accessories: [] },
      files: [e1, e2],
    };
    await writeLockfile(proj, lock);

    // Hand-edit one.
    await fs.writeFile(path.join(proj, e2.path), 'b-edited\n');

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: true },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(code).toBe(0);
    expect(cap.err.join('')).toBe('');

    expect(await fileExists(path.join(proj, e1.path))).toBe(false);
    expect(await fileExists(path.join(proj, e2.path))).toBe(false);
    expect(await readLockfile(proj)).toBeNull();

    const out = cap.out.join('');
    expect(out).toMatch(/Removed 2 files/);
    expect(out).toMatch(/Force-deleted 1 hand-edited file:/);
    expect(out).toMatch(/\.claude\/skills\/b\/SKILL\.md/);
  });
});

describe('runOff — parent directory cleanup', () => {
  it('preserves a non-empty parent directory containing user-authored content', async () => {
    const proj = await mkProject();
    // Suit-owned file.
    const e1 = await plant(proj, '.claude/skills/idiomatic-go/SKILL.md', 'body\n');
    // User-authored sibling under .claude — must survive.
    await fs.mkdir(path.join(proj, '.claude'), { recursive: true });
    await fs.writeFile(path.join(proj, '.claude', 'user-config.json'), '{"user":"keep me"}\n');

    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: 'backend', mode: null, accessories: [] },
      files: [e1],
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(code).toBe(0);

    // Empty intermediate dirs gone.
    expect(await fileExists(path.join(proj, '.claude/skills/idiomatic-go'))).toBe(false);
    expect(await fileExists(path.join(proj, '.claude/skills'))).toBe(false);
    // .claude/ itself preserved (user-authored sibling still inside).
    expect(await fileExists(path.join(proj, '.claude'))).toBe(true);
    expect(await fileExists(path.join(proj, '.claude/user-config.json'))).toBe(true);
  });
});

describe('runOff — .suit/ dir cleanup', () => {
  it('removes .suit/ when only lock.json was inside', async () => {
    const proj = await mkProject();
    const e1 = await plant(proj, '.claude/CLAUDE.md', 'x\n');
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: 'backend', mode: null, accessories: [] },
      files: [e1],
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(code).toBe(0);

    expect(await fileExists(path.join(proj, '.suit'))).toBe(false);
    expect(await fileExists(path.join(proj, LOCKFILE_PATH))).toBe(false);
  });

  it('preserves .suit/ when other contents exist (e.g. project overlay)', async () => {
    const proj = await mkProject();
    const e1 = await plant(proj, '.claude/CLAUDE.md', 'x\n');
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: 'backend', mode: null, accessories: [] },
      files: [e1],
    };
    await writeLockfile(proj, lock);

    // Drop a sibling file inside .suit/ that suit didn't write — a future
    // "project overlay" or user-authored note. It must survive `suit off`.
    await fs.writeFile(path.join(proj, '.suit', 'project-overlay.md'), '# overlay\n');

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(code).toBe(0);

    expect(await fileExists(path.join(proj, LOCKFILE_PATH))).toBe(false);
    expect(await fileExists(path.join(proj, '.suit'))).toBe(true);
    expect(await fileExists(path.join(proj, '.suit', 'project-overlay.md'))).toBe(true);
  });
});
