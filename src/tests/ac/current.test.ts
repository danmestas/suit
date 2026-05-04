import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCurrent } from '../../lib/ac/current.js';
import { writeLockfile, sha256OfBuffer, type Lockfile } from '../../lib/lockfile.js';

const cleanupQueue: string[] = [];
afterEach(async () => {
  while (cleanupQueue.length > 0) {
    const dir = cleanupQueue.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function mkProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suit-current-'));
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

describe('runCurrent', () => {
  it('reports the friendly message and exits 0 when no lockfile exists', async () => {
    const proj = await mkProject();
    const cap = capture();
    const code = await runCurrent({ projectDir: proj }, { stdout: cap.push, stderr: cap.pushE });
    expect(code).toBe(0);
    expect(cap.out.join('')).toMatch(/no suit applied/);
  });

  it('reports resolution, applied-at timestamp, and file count', async () => {
    const proj = await mkProject();
    // Materialize a tracked file so its sha matches the lockfile.
    const filePath = '.claude/skills/foo/SKILL.md';
    await fs.mkdir(path.dirname(path.join(proj, filePath)), { recursive: true });
    const body = '# foo\n';
    await fs.writeFile(path.join(proj, filePath), body);
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: '2026-05-04T19:06:54Z',
      resolution: { outfit: 'backend', mode: 'focused', accessories: ['axiom'] },
      files: [
        { path: filePath, sha256: sha256OfBuffer(body), sourceComponent: 'skills/foo' },
      ],
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    const code = await runCurrent({ projectDir: proj }, { stdout: cap.push, stderr: cap.pushE });
    expect(code).toBe(0);
    const out = cap.out.join('');
    expect(out).toMatch(/outfit:\s+backend/);
    expect(out).toMatch(/mode:\s+focused/);
    expect(out).toMatch(/axiom/);
    expect(out).toMatch(/2026-05-04T19:06:54Z/);
    expect(out).toMatch(/files:\s+1/);
    // No drift section when everything matches.
    expect(out).not.toMatch(/drift detected/);
  });

  it('reports drift for hand-edited tracked files (still exit 0)', async () => {
    const proj = await mkProject();
    const filePath = '.claude/CLAUDE.md';
    await fs.mkdir(path.dirname(path.join(proj, filePath)), { recursive: true });
    const original = '# original\n';
    await fs.writeFile(path.join(proj, filePath), original);
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: '2026-05-04T19:06:54Z',
      resolution: { outfit: 'backend', mode: null, accessories: [] },
      files: [
        { path: filePath, sha256: sha256OfBuffer(original), sourceComponent: 'rules/x' },
      ],
    };
    await writeLockfile(proj, lock);

    // Hand-edit the tracked file.
    await fs.writeFile(path.join(proj, filePath), '# edited\n');

    const cap = capture();
    const code = await runCurrent({ projectDir: proj }, { stdout: cap.push, stderr: cap.pushE });
    expect(code).toBe(0);
    const out = cap.out.join('');
    expect(out).toMatch(/drift detected/);
    expect(out).toMatch(new RegExp(`drift: ${filePath.replace('.', '\\.')}`));
  });

  it('reports missing tracked files as drift', async () => {
    const proj = await mkProject();
    const filePath = '.claude/CLAUDE.md';
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: '2026-05-04T19:06:54Z',
      resolution: { outfit: 'backend', mode: null, accessories: [] },
      files: [
        { path: filePath, sha256: 'a'.repeat(64), sourceComponent: 'rules/x' },
      ],
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    const code = await runCurrent({ projectDir: proj }, { stdout: cap.push, stderr: cap.pushE });
    expect(code).toBe(0);
    expect(cap.out.join('')).toMatch(/missing/);
  });

  it('truncates long file lists with "... and N more"', async () => {
    const proj = await mkProject();
    const files = [];
    for (let i = 0; i < 10; i++) {
      const p = `.claude/skills/s${i}/SKILL.md`;
      await fs.mkdir(path.dirname(path.join(proj, p)), { recursive: true });
      const body = `# s${i}\n`;
      await fs.writeFile(path.join(proj, p), body);
      files.push({ path: p, sha256: sha256OfBuffer(body), sourceComponent: `skills/s${i}` });
    }
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: '2026-05-04T19:06:54Z',
      resolution: { outfit: 'backend', mode: null, accessories: [] },
      files,
    };
    await writeLockfile(proj, lock);

    const cap = capture();
    await runCurrent({ projectDir: proj }, { stdout: cap.push, stderr: cap.pushE });
    expect(cap.out.join('')).toMatch(/and 5 more/);
  });
});
