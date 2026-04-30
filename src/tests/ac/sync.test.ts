import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSync } from '../../lib/ac/sync';
import { openContentStore } from '../../lib/content-store';

describe('runSync', () => {
  let tmp: string;
  let sourceRepo: string;
  let target: string;
  let logs: string[];
  let errs: string[];

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'suit-runsync-'));
    sourceRepo = path.join(tmp, 'source');
    target = path.join(tmp, 'content');
    mkdirSync(sourceRepo);
    execSync('git init -q -b main', { cwd: sourceRepo });
    execSync('git config user.email "t@t.com"', { cwd: sourceRepo });
    execSync('git config user.name "t"', { cwd: sourceRepo });
    writeFileSync(path.join(sourceRepo, 'README.md'), 'v1');
    execSync('git add -A && git commit -qm v1', { cwd: sourceRepo });

    await openContentStore(target).init(sourceRepo, false);
    logs = [];
    errs = [];
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('exits 0 with up-to-date message when nothing to pull', async () => {
    const code = await runSync(
      { contentDir: target },
      { stdout: (s) => logs.push(s), stderr: (s) => errs.push(s) },
    );
    expect(code).toBe(0);
    expect(logs.join('')).toMatch(/up to date/i);
  });

  it('exits 0 and reports updated commits when remote has new commits', async () => {
    writeFileSync(path.join(sourceRepo, 'README.md'), 'v2');
    execSync('git add -A && git commit -qm v2', { cwd: sourceRepo });
    const code = await runSync(
      { contentDir: target },
      { stdout: (s) => logs.push(s), stderr: (s) => errs.push(s) },
    );
    expect(code).toBe(0);
    expect(logs.join('')).toMatch(/Updated 1 commit/);
  });

  it('exits 1 with clear error when content dir missing', async () => {
    rmSync(target, { recursive: true, force: true });
    const code = await runSync(
      { contentDir: target },
      { stdout: (s) => logs.push(s), stderr: (s) => errs.push(s) },
    );
    expect(code).toBe(1);
    expect(errs.join('')).toMatch(/does not exist|run.*init/i);
  });

  it('exits 1 with clear error when working tree dirty', async () => {
    writeFileSync(path.join(target, 'dirty'), 'x');
    const code = await runSync(
      { contentDir: target },
      { stdout: (s) => logs.push(s), stderr: (s) => errs.push(s) },
    );
    expect(code).toBe(1);
    expect(errs.join('')).toMatch(/uncommitted|dirty/i);
  });
});
