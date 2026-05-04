import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  LOCKFILE_PATH,
  readLockfile,
  writeLockfile,
  deleteLockfile,
  sha256OfBuffer,
  sha256OfFile,
  type Lockfile,
} from '../lib/lockfile.ts';

const cleanupQueue: string[] = [];
afterEach(async () => {
  while (cleanupQueue.length > 0) {
    const dir = cleanupQueue.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function mkProjectMock(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lockfile-test-'));
  cleanupQueue.push(dir);
  return dir;
}

const sampleLock: Lockfile = {
  schemaVersion: 1,
  appliedAt: '2026-05-04T19:06:54Z',
  resolution: {
    outfit: 'backend',
    mode: 'focused',
    accessories: ['axiom', 'linear'],
  },
  files: [
    {
      path: '.claude/CLAUDE.md',
      sha256: 'a'.repeat(64),
      sourceComponent: 'outfits/backend',
    },
    {
      path: '.claude/skills/idiomatic-go/SKILL.md',
      sha256: 'b'.repeat(64),
      sourceComponent: 'skills/idiomatic-go',
    },
  ],
};

describe('writeLockfile / readLockfile', () => {
  it('round-trips a Lockfile structurally', async () => {
    const proj = await mkProjectMock();
    await writeLockfile(proj, sampleLock);
    const got = await readLockfile(proj);
    expect(got).toEqual(sampleLock);
  });

  it('creates the .suit/ dir if missing', async () => {
    const proj = await mkProjectMock();
    await writeLockfile(proj, sampleLock);
    const stat = await fs.stat(path.join(proj, '.suit'));
    expect(stat.isDirectory()).toBe(true);
    const lockStat = await fs.stat(path.join(proj, LOCKFILE_PATH));
    expect(lockStat.mode & 0o777).toBe(0o644);
  });

  it('overwrites a prior lockfile', async () => {
    const proj = await mkProjectMock();
    await writeLockfile(proj, sampleLock);
    const updated: Lockfile = {
      ...sampleLock,
      resolution: { outfit: 'frontend', mode: null, accessories: [] },
      files: [],
    };
    await writeLockfile(proj, updated);
    expect(await readLockfile(proj)).toEqual(updated);
  });
});

describe('readLockfile', () => {
  it('returns null when the lockfile is missing', async () => {
    const proj = await mkProjectMock();
    expect(await readLockfile(proj)).toBeNull();
  });

  it('returns null when the .suit/ directory is missing entirely', async () => {
    const proj = await mkProjectMock();
    expect(await readLockfile(proj)).toBeNull();
  });

  it('rejects malformed JSON', async () => {
    const proj = await mkProjectMock();
    await fs.mkdir(path.join(proj, '.suit'), { recursive: true });
    await fs.writeFile(path.join(proj, LOCKFILE_PATH), '{not json');
    await expect(readLockfile(proj)).rejects.toThrow(/invalid JSON/);
  });

  it('rejects a lockfile missing schemaVersion', async () => {
    const proj = await mkProjectMock();
    await fs.mkdir(path.join(proj, '.suit'), { recursive: true });
    await fs.writeFile(path.join(proj, LOCKFILE_PATH), JSON.stringify({
      appliedAt: '2026-05-04T19:06:54Z',
      resolution: { outfit: null, mode: null, accessories: [] },
      files: [],
    }));
    await expect(readLockfile(proj)).rejects.toThrow(/schema validation failed/);
  });

  it('rejects an unsupported schemaVersion', async () => {
    const proj = await mkProjectMock();
    await fs.mkdir(path.join(proj, '.suit'), { recursive: true });
    await fs.writeFile(path.join(proj, LOCKFILE_PATH), JSON.stringify({
      schemaVersion: 2,
      appliedAt: '2026-05-04T19:06:54Z',
      resolution: { outfit: null, mode: null, accessories: [] },
      files: [],
    }));
    await expect(readLockfile(proj)).rejects.toThrow(/schema validation failed/);
  });

  it('rejects an entry with a non-hex sha256', async () => {
    const proj = await mkProjectMock();
    await fs.mkdir(path.join(proj, '.suit'), { recursive: true });
    await fs.writeFile(path.join(proj, LOCKFILE_PATH), JSON.stringify({
      schemaVersion: 1,
      appliedAt: '2026-05-04T19:06:54Z',
      resolution: { outfit: null, mode: null, accessories: [] },
      files: [{ path: 'a', sha256: 'too-short', sourceComponent: 'x' }],
    }));
    await expect(readLockfile(proj)).rejects.toThrow(/schema validation failed/);
  });
});

describe('writeLockfile validation', () => {
  it('rejects a structurally invalid input rather than persisting it', async () => {
    const proj = await mkProjectMock();
    const bad = { schemaVersion: 1, files: [] } as unknown as Lockfile;
    await expect(writeLockfile(proj, bad)).rejects.toThrow();
    // Did not create the file
    expect(await readLockfile(proj)).toBeNull();
  });
});

describe('deleteLockfile', () => {
  it('removes the lockfile and the empty .suit/ dir', async () => {
    const proj = await mkProjectMock();
    await writeLockfile(proj, sampleLock);
    await deleteLockfile(proj);
    expect(await readLockfile(proj)).toBeNull();
    await expect(fs.stat(path.join(proj, '.suit'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a non-empty .suit/ dir alone', async () => {
    const proj = await mkProjectMock();
    await writeLockfile(proj, sampleLock);
    // Drop a sibling file inside .suit/ that suit didn't create
    await fs.writeFile(path.join(proj, '.suit', 'extra.txt'), 'kept');
    await deleteLockfile(proj);
    const remaining = await fs.readdir(path.join(proj, '.suit'));
    expect(remaining).toEqual(['extra.txt']);
  });

  it('is idempotent on a missing lockfile', async () => {
    const proj = await mkProjectMock();
    await expect(deleteLockfile(proj)).resolves.toBeUndefined();
    await expect(deleteLockfile(proj)).resolves.toBeUndefined();
  });
});

describe('sha256 helpers', () => {
  it('sha256OfBuffer matches a known vector', () => {
    expect(sha256OfBuffer('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('sha256OfBuffer accepts both string and Buffer with the same digest', () => {
    const s = 'hello suit';
    const fromString = sha256OfBuffer(s);
    const fromBuffer = sha256OfBuffer(Buffer.from(s, 'utf8'));
    expect(fromString).toBe(fromBuffer);
  });

  it('sha256OfFile agrees with sha256OfBuffer for the same content', async () => {
    const proj = await mkProjectMock();
    const file = path.join(proj, 'sample.txt');
    const body = 'lorem ipsum dolor sit amet';
    await fs.writeFile(file, body);
    const fromBuffer = sha256OfBuffer(body);
    const fromFile = await sha256OfFile(file);
    expect(fromFile).toBe(fromBuffer);
  });
});
