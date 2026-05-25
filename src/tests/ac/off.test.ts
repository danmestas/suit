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
      resolution: { outfit: 'backend', cut: null, accessories: [] },
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
      resolution: { outfit: 'backend', cut: null, accessories: [] },
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
      resolution: { outfit: 'backend', cut: null, accessories: [] },
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
      resolution: { outfit: 'backend', cut: null, accessories: [] },
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
      resolution: { outfit: 'backend', cut: null, accessories: [] },
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
      resolution: { outfit: 'backend', cut: null, accessories: [] },
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
      resolution: { outfit: 'backend', cut: null, accessories: [] },
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

// --- injected component removal (slice e/4) -------------------------------

/** Marker-wrapped additive block, mirroring writer.ts's SUIT_BLOCK shape. */
function additiveBlock(name: string, body: string): string {
  return `<!-- suit:outfit:${name} -->\n${body}\n<!-- /suit:outfit:${name} -->`;
}

describe('runOff — injected file removal (both up + injected)', () => {
  it('removes up files AND injected files, then deletes the lockfile', async () => {
    const proj = await mkProject();
    const up1 = await plant(proj, '.claude/CLAUDE.md', '# up\n');
    const inj1 = await plant(proj, '.claude/skills/phil/SKILL.md', 'phil body\n', 'skills/phil');
    const inj2 = await plant(proj, '.claude/skills/norm/SKILL.md', 'norm body\n', 'skills/norm');
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: 'backend', cut: null, accessories: [] },
      files: [up1],
      injected: [
        {
          component: 'philosophy',
          injectedAt: new Date().toISOString(),
          files: [inj1, inj2],
        },
      ],
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(cap.err.join('')).toBe('');
    expect(code).toBe(0);

    expect(await fileExists(path.join(proj, up1.path))).toBe(false);
    expect(await fileExists(path.join(proj, inj1.path))).toBe(false);
    expect(await fileExists(path.join(proj, inj2.path))).toBe(false);
    expect(await readLockfile(proj)).toBeNull();

    const out = cap.out.join('');
    expect(out).toMatch(/Removed 3 files/);
    expect(out).toMatch(/Removed 2 injected file\(s\) \(1 component\(s\)\)/);
    expect(out).toMatch(/Removed lockfile:/);
  });
});

describe('runOff — inject-only lockfile (the orphan bug)', () => {
  it('removes injected files and deletes the lockfile when files:[]', async () => {
    const proj = await mkProject();
    const inj1 = await plant(proj, '.claude/skills/a/SKILL.md', 'a\n', 'skills/a');
    const inj2 = await plant(proj, '.claude/skills/b/SKILL.md', 'b\n', 'skills/b');
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: null, cut: null, accessories: [] },
      files: [],
      injected: [
        {
          component: 'philosophy',
          injectedAt: new Date().toISOString(),
          files: [inj1, inj2],
        },
      ],
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(cap.err.join('')).toBe('');
    expect(code).toBe(0);

    // Injected files gone (no longer orphaned).
    expect(await fileExists(path.join(proj, inj1.path))).toBe(false);
    expect(await fileExists(path.join(proj, inj2.path))).toBe(false);
    // Lockfile gone.
    expect(await readLockfile(proj)).toBeNull();
    expect(await fileExists(path.join(proj, '.suit'))).toBe(false);

    const out = cap.out.join('');
    expect(out).toMatch(/Removed 2 injected file\(s\) \(1 component\(s\)\)/);
  });
});

describe('runOff — drift on an injected file', () => {
  it('refuses without --force, lists the injected drift, then removes under --force', async () => {
    const proj = await mkProject();
    const inj1 = await plant(proj, '.claude/skills/a/SKILL.md', 'a-original\n', 'skills/a');
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: null, cut: null, accessories: [] },
      files: [],
      injected: [
        {
          component: 'philosophy',
          injectedAt: new Date().toISOString(),
          files: [inj1],
        },
      ],
    };
    await writeLockfile(proj, lock);

    // Hand-edit the injected file.
    await fs.writeFile(path.join(proj, inj1.path), 'a-edited\n');

    // Non-force: refuse, list it the same as an up drift.
    const cap1 = capture();
    const code1 = await runOff(
      { projectDir: proj, force: false },
      { stdout: cap1.push, stderr: cap1.pushE },
    );
    expect(code1).toBe(1);
    const err = cap1.err.join('');
    expect(err).toMatch(/hand-edited since suit applied it: \.claude\/skills\/a\/SKILL\.md/);
    expect(err).toMatch(/refusing to delete 1 hand-edited file/);
    expect(await fileExists(path.join(proj, inj1.path))).toBe(true);
    expect(await readLockfile(proj)).not.toBeNull();

    // Force: remove anyway, report as forcedDrift.
    const cap2 = capture();
    const code2 = await runOff(
      { projectDir: proj, force: true },
      { stdout: cap2.push, stderr: cap2.pushE },
    );
    expect(code2).toBe(0);
    expect(await fileExists(path.join(proj, inj1.path))).toBe(false);
    expect(await readLockfile(proj)).toBeNull();
    const out = cap2.out.join('');
    expect(out).toMatch(/Force-deleted 1 hand-edited file:/);
    expect(out).toMatch(/\.claude\/skills\/a\/SKILL\.md/);
  });
});

describe('runOff — additive injected file', () => {
  it('strips just the marker block, preserving surrounding user content', async () => {
    const proj = await mkProject();
    const block = additiveBlock('philosophy', 'INJECTED LINE');
    const userBefore = '# my notes\n\n';
    const userAfter = '\n\n# more notes\n';
    const full = path.join(proj, '.claude/CLAUDE.md');
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, userBefore + block + userAfter);

    const inj1 = {
      path: '.claude/CLAUDE.md',
      sha256: sha256OfBuffer(block),
      sourceComponent: 'accessories/philosophy',
      mode: 'additive' as const,
    };
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: null, cut: null, accessories: [] },
      files: [],
      injected: [
        { component: 'philosophy', injectedAt: new Date().toISOString(), files: [inj1] },
      ],
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(code).toBe(0);
    expect(cap.err.join('')).toBe('');

    // File survives, block gone, user content kept.
    expect(await fileExists(full)).toBe(true);
    const remaining = await fs.readFile(full, 'utf8');
    expect(remaining).not.toMatch(/INJECTED LINE/);
    expect(remaining).toMatch(/my notes/);
    expect(remaining).toMatch(/more notes/);
  });

  it('deletes the host file when the additive injected block was its only content', async () => {
    const proj = await mkProject();
    const block = additiveBlock('philosophy', 'ONLY CONTENT');
    const full = path.join(proj, '.claude/skills/x/SKILL.md');
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, block);

    const inj1 = {
      path: '.claude/skills/x/SKILL.md',
      sha256: sha256OfBuffer(block),
      sourceComponent: 'skills/x',
      mode: 'additive' as const,
    };
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: null, cut: null, accessories: [] },
      files: [],
      injected: [
        { component: 'philosophy', injectedAt: new Date().toISOString(), files: [inj1] },
      ],
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(code).toBe(0);
    expect(await fileExists(full)).toBe(false);
    expect(await fileExists(path.join(proj, '.claude/skills/x'))).toBe(false);
  });
});

describe('runOff --keep-injected', () => {
  it('removes up files, keeps injected files, and rewrites the lockfile', async () => {
    const proj = await mkProject();
    const up1 = await plant(proj, '.claude/CLAUDE.md', '# up\n');
    const inj1 = await plant(proj, '.claude/skills/a/SKILL.md', 'a\n', 'skills/a');
    const inj2 = await plant(proj, '.claude/skills/b/SKILL.md', 'b\n', 'skills/b');
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: 'backend', fit: 'go', cut: 'executing', accessories: ['pr-policy'] },
      files: [up1],
      injected: [
        { component: 'philosophy', injectedAt: new Date().toISOString(), files: [inj1, inj2] },
      ],
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false, keepInjected: true },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(cap.err.join('')).toBe('');
    expect(code).toBe(0);

    // Up file gone.
    expect(await fileExists(path.join(proj, up1.path))).toBe(false);
    // Injected files survive.
    expect(await fileExists(path.join(proj, inj1.path))).toBe(true);
    expect(await fileExists(path.join(proj, inj2.path))).toBe(true);

    // Lockfile retained, rewritten: files cleared, resolution reset, injected kept.
    const after = await readLockfile(proj);
    expect(after).not.toBeNull();
    expect(after!.files).toEqual([]);
    expect(after!.resolution.outfit).toBeNull();
    expect(after!.resolution.cut).toBeNull();
    expect(after!.resolution.accessories).toEqual([]);
    expect(after!.injected).toHaveLength(1);
    expect(after!.injected![0].files).toHaveLength(2);

    const out = cap.out.join('');
    expect(out).toMatch(/Kept 2 injected file\(s\) \(1 component\(s\)\); lockfile retained/);
    expect(out).not.toMatch(/Removed lockfile:/);
  });

  it('behaves like a full off (deletes lockfile) when there are no injected entries', async () => {
    const proj = await mkProject();
    const up1 = await plant(proj, '.claude/CLAUDE.md', '# up\n');
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      resolution: { outfit: 'backend', cut: null, accessories: [] },
      files: [up1],
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    const code = await runOff(
      { projectDir: proj, force: false, keepInjected: true },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(code).toBe(0);
    expect(await fileExists(path.join(proj, up1.path))).toBe(false);
    expect(await readLockfile(proj)).toBeNull();
    expect(cap.out.join('')).toMatch(/Removed lockfile:/);
  });
});
