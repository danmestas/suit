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
});
