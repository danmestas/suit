import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from '../../lib/ac/init.js';

describe('runInit', () => {
  let tmp: string;
  let sourceRepo: string;
  let target: string;
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'suit-runinit-'));
    sourceRepo = path.join(tmp, 'source');
    target = path.join(tmp, 'content');
    mkdirSync(sourceRepo);
    execSync('git init -q', { cwd: sourceRepo });
    execSync('git config user.email "t@t.com"', { cwd: sourceRepo });
    execSync('git config user.name "t"', { cwd: sourceRepo });
    writeFileSync(path.join(sourceRepo, 'README.md'), 'hi');
    mkdirSync(path.join(sourceRepo, 'personas'));
    writeFileSync(
      path.join(sourceRepo, 'personas', 'demo.md'),
      '---\nname: demo\n---\nbody',
    );
    execSync('git add -A && git commit -qm init', { cwd: sourceRepo });
    logs = [];
    errs = [];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('clones to target and exits 0', async () => {
    const code = await runInit(
      { url: sourceRepo, force: false, contentDir: target },
      { stdout: (s) => logs.push(s), stderr: (s) => errs.push(s) },
    );
    expect(code).toBe(0);
    expect(existsSync(path.join(target, '.git'))).toBe(true);
    expect(existsSync(path.join(target, 'personas'))).toBe(true);
    expect(logs.join('')).toMatch(/cloned/i);
  });

  it('errors and exits 1 when target exists without force', async () => {
    mkdirSync(target);
    writeFileSync(path.join(target, 'x'), 'x');
    const code = await runInit(
      { url: sourceRepo, force: false, contentDir: target },
      { stdout: (s) => logs.push(s), stderr: (s) => errs.push(s) },
    );
    expect(code).toBe(1);
    expect(errs.join('')).toMatch(/already exists/i);
  });

  it('overwrites with --force', async () => {
    mkdirSync(target);
    writeFileSync(path.join(target, 'old'), 'x');
    const code = await runInit(
      { url: sourceRepo, force: true, contentDir: target },
      { stdout: (s) => logs.push(s), stderr: (s) => errs.push(s) },
    );
    expect(code).toBe(0);
    expect(existsSync(path.join(target, 'old'))).toBe(false);
  });

  it('warns (does not error) when cloned content lacks personas/ and modes/', async () => {
    const empty = path.join(tmp, 'empty');
    mkdirSync(empty);
    execSync('git init -q', { cwd: empty });
    execSync('git config user.email "t@t.com"', { cwd: empty });
    execSync('git config user.name "t"', { cwd: empty });
    writeFileSync(path.join(empty, 'README.md'), 'no content');
    execSync('git add -A && git commit -qm init', { cwd: empty });

    const code = await runInit(
      { url: empty, force: false, contentDir: target },
      { stdout: (s) => logs.push(s), stderr: (s) => errs.push(s) },
    );
    expect(code).toBe(0);
    expect(errs.join('')).toMatch(/personas|modes/i);
  });
});
