import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStatus } from '../../lib/ac/status.js';

describe('runStatus', () => {
  let tmp: string;
  let logs: string[];

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'suit-status-'));
    logs = [];
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('reports "no content" when content dir is missing', async () => {
    const code = await runStatus(
      { contentDir: path.join(tmp, 'missing'), version: '0.2.0', harnesses: [] },
      { stdout: (s) => logs.push(s), whichBin: () => null },
    );
    expect(code).toBe(0);
    const out = logs.join('');
    expect(out).toMatch(/no content|run.*init/i);
  });

  it('reports clone source for an initialized git repo', async () => {
    const target = path.join(tmp, 'content');
    mkdirSync(target);
    execSync('git init -q', { cwd: target });
    execSync('git remote add origin https://github.com/example/repo.git', { cwd: target });
    const code = await runStatus(
      { contentDir: target, version: '0.2.0', harnesses: [] },
      { stdout: (s) => logs.push(s), whichBin: () => null },
    );
    expect(code).toBe(0);
    expect(logs.join('')).toContain('https://github.com/example/repo.git');
  });

  it('reports harness presence', async () => {
    const target = path.join(tmp, 'content');
    mkdirSync(target);
    const code = await runStatus(
      {
        contentDir: target,
        version: '0.2.0',
        harnesses: ['claude-code', 'codex'],
      },
      {
        stdout: (s) => logs.push(s),
        whichBin: (bin) => (bin === 'claude' ? '/usr/local/bin/claude' : null),
      },
    );
    expect(code).toBe(0);
    const out = logs.join('');
    expect(out).toMatch(/claude-code.*✓/);
    expect(out).toMatch(/codex.*✗/);
  });

  it('always exits 0 even with everything missing', async () => {
    const code = await runStatus(
      { contentDir: '/nope', version: '0.2.0', harnesses: ['claude-code'] },
      { stdout: (s) => logs.push(s), whichBin: () => null },
    );
    expect(code).toBe(0);
  });

  it('prints version on first line', async () => {
    const code = await runStatus(
      { contentDir: '/nope', version: '0.2.0', harnesses: [] },
      { stdout: (s) => logs.push(s), whichBin: () => null },
    );
    expect(code).toBe(0);
    expect(logs[0] ?? '').toMatch(/suit\s+v0\.2\.0/);
  });

  // ─── v0.5.3: staleness check ─────────────────────────────────────────────

  // Helper: bootstrap a bare repo + a clone tracking origin/main. Robust
  // across environments where `init.defaultBranch` defaults to `master`
  // (older git, container distros without a system gitconfig). We force the
  // bare repo's HEAD to `main` after init so the eventual `git clone`
  // doesn't see a missing default branch.
  const bootstrapWardrobe = (
    remote: string,
    work: string,
    cache: string,
  ): void => {
    execSync(`git init -q --bare "${remote}"`);
    execSync(`git -C "${remote}" symbolic-ref HEAD refs/heads/main`);
    mkdirSync(work);
    execSync('git init -q -b main', { cwd: work });
    execSync('git config user.email t@t.t && git config user.name t', { cwd: work });
    execSync('echo a > a.txt && git add . && git commit -q -m a', { cwd: work });
    execSync(`git remote add origin "${remote}" && git push -q origin main`, { cwd: work });
    execSync(`git clone -q "${remote}" "${cache}"`);
  };

  it('reports "N commits behind" when the cache is behind its upstream', async () => {
    // Simulate a wardrobe + remote both locally so no network is involved.
    // 1. Bootstrap bare-remote + work + clone (cache).
    // 2. Add another commit to the remote so the cache is now behind by 1.
    // 3. runStatus should detect the divergence after its internal `git fetch`.
    const remote = path.join(tmp, 'remote.git');
    const work = path.join(tmp, 'work');
    const cache = path.join(tmp, 'cache');
    bootstrapWardrobe(remote, work, cache);
    // Add a commit upstream so cache is now 1 behind.
    execSync('echo b > b.txt && git add . && git commit -q -m b && git push -q origin main', { cwd: work });

    const code = await runStatus(
      { contentDir: cache, version: '0.5.3', harnesses: [] },
      { stdout: (s) => logs.push(s), whichBin: () => null },
    );
    expect(code).toBe(0);
    const out = logs.join('');
    expect(out).toMatch(/Wardrobe:\s+1 commit behind/);
  });

  it('omits the staleness line when the cache is up to date', async () => {
    const remote = path.join(tmp, 'remote.git');
    const work = path.join(tmp, 'work');
    const cache = path.join(tmp, 'cache');
    bootstrapWardrobe(remote, work, cache);

    const code = await runStatus(
      { contentDir: cache, version: '0.5.3', harnesses: [] },
      { stdout: (s) => logs.push(s), whichBin: () => null },
    );
    expect(code).toBe(0);
    const out = logs.join('');
    expect(out).not.toMatch(/commits? behind/);
  });
});
