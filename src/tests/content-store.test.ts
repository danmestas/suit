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
