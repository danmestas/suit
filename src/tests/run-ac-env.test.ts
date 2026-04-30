import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAc } from '../lib/ac/run';

describe('runAc honors SUIT_CONTENT_PATH (regression)', () => {
  let tmp: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'suit-envreg-'));
    mkdirSync(path.join(tmp, 'personas', 'demo'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'personas', 'demo', 'persona.md'),
      '---\nname: demo\nversion: 1.0.0\ntype: persona\ndescription: d\ntargets: [claude-code]\ncategories: [tooling]\n---\nbody',
    );
    originalEnv = process.env.SUIT_CONTENT_PATH;
    process.env.SUIT_CONTENT_PATH = tmp;
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.SUIT_CONTENT_PATH = originalEnv;
    else delete process.env.SUIT_CONTENT_PATH;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('finds persona from SUIT_CONTENT_PATH directory', async () => {
    const exitCode = await runAc(['claude', '--persona', 'demo', '--no-filter'], {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir: tmp,
      resolveHarnessBin: () => 'true',
      exec: async () => 0,
    });
    expect(exitCode).toBe(0);
  });

  it('errors when persona not found in any tier', async () => {
    // Without --no-filter, runAc resolves persona via findPersona which throws
    // for unknown names. The thrown error propagates as a rejected promise.
    await expect(
      runAc(['claude', '--persona', 'missing'], {
        projectDir: '/nonexistent',
        userDir: '/nonexistent',
        builtinDir: tmp,
        resolveHarnessBin: () => 'true',
        exec: async () => 0,
      }),
    ).rejects.toThrow(/persona not found/);
  });
});
