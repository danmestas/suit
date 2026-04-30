import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openContentStore } from '../lib/content-store';

describe('ContentStore.status', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'suit-store-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns exists=false when target dir does not exist', async () => {
    const store = openContentStore(path.join(tmp, 'missing'));
    const s = await store.status();
    expect(s.exists).toBe(false);
    expect(s.remote).toBeUndefined();
  });

  it('returns exists=true and remote URL for a git repo', async () => {
    const target = path.join(tmp, 'content');
    mkdirSync(target, { recursive: true });
    execSync('git init -q', { cwd: target });
    execSync('git remote add origin https://github.com/example/repo.git', { cwd: target });

    const store = openContentStore(target);
    const s = await store.status();
    expect(s.exists).toBe(true);
    expect(s.remote).toBe('https://github.com/example/repo.git');
  });

  it('returns exists=true with no remote for a git repo without origin', async () => {
    const target = path.join(tmp, 'content');
    mkdirSync(target, { recursive: true });
    execSync('git init -q', { cwd: target });

    const store = openContentStore(target);
    const s = await store.status();
    expect(s.exists).toBe(true);
    expect(s.remote).toBeUndefined();
  });
});

describe('ContentStore.init', () => {
  let tmp: string;
  let sourceRepo: string;
  let target: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'suit-init-'));
    sourceRepo = path.join(tmp, 'source');
    target = path.join(tmp, 'target');
    mkdirSync(sourceRepo, { recursive: true });
    execSync('git init -q', { cwd: sourceRepo });
    execSync('git config user.email "t@t.com"', { cwd: sourceRepo });
    execSync('git config user.name "t"', { cwd: sourceRepo });
    writeFileSync(path.join(sourceRepo, 'README.md'), 'hi');
    execSync('git add -A && git commit -qm init', { cwd: sourceRepo });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('clones the URL into the target', async () => {
    const store = openContentStore(target);
    await store.init(sourceRepo, false);
    expect(existsSync(path.join(target, '.git'))).toBe(true);
    expect(existsSync(path.join(target, 'README.md'))).toBe(true);
  });

  it('throws if target exists and force=false', async () => {
    mkdirSync(target);
    writeFileSync(path.join(target, 'something'), 'x');
    const store = openContentStore(target);
    await expect(store.init(sourceRepo, false)).rejects.toThrow(/already exists/);
  });

  it('overwrites if force=true', async () => {
    mkdirSync(target);
    writeFileSync(path.join(target, 'old-file'), 'x');
    const store = openContentStore(target);
    await store.init(sourceRepo, true);
    expect(existsSync(path.join(target, 'old-file'))).toBe(false);
    expect(existsSync(path.join(target, 'README.md'))).toBe(true);
  });
});
