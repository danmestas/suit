import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAc } from '../lib/ac/run.js';

describe('runAc honors SUIT_CONTENT_PATH (regression)', () => {
  let tmp: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'suit-envreg-'));
    mkdirSync(path.join(tmp, 'outfits', 'demo'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'outfits', 'demo', 'outfit.md'),
      '---\nname: demo\nversion: 1.0.0\ntype: outfit\ndescription: d\ntargets: [claude-code]\ncategories: [tooling]\n---\nbody',
    );
    originalEnv = process.env.SUIT_CONTENT_PATH;
    process.env.SUIT_CONTENT_PATH = tmp;
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.SUIT_CONTENT_PATH = originalEnv;
    else delete process.env.SUIT_CONTENT_PATH;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('finds outfit from SUIT_CONTENT_PATH directory', async () => {
    const exitCode = await runAc(['claude', '--outfit', 'demo', '--no-filter'], {
      projectDir: '/nonexistent',
      userDir: '/nonexistent',
      builtinDir: tmp,
      resolveHarnessBin: () => 'true',
      exec: async () => 0,
    });
    expect(exitCode).toBe(0);
  });

  it('errors when outfit not found in any tier', async () => {
    // Without --no-filter, runAc resolves outfit via findOutfit which throws
    // for unknown names. The thrown error propagates as a rejected promise.
    await expect(
      runAc(['claude', '--outfit', 'missing'], {
        projectDir: '/nonexistent',
        userDir: '/nonexistent',
        builtinDir: tmp,
        resolveHarnessBin: () => 'true',
        exec: async () => 0,
      }),
    ).rejects.toThrow(/outfit not found/);
  });
});
