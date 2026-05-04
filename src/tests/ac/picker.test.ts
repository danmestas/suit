/**
 * Picker tests — exercise the discoverable surface (empty-wardrobe error path)
 * without trying to mock readline. The actual prompt loop is small (3
 * questions) and gets covered manually in Phase E's e2e + interactive smoke.
 *
 * Numbered-list rendering and parseChoice logic live behind closure scope
 * inside picker.ts; we test them indirectly via the empty-wardrobe rejection
 * path which exercises module loading + listAllOutfits/Modes/Accessories.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPicker } from '../../lib/ac/picker.ts';

async function mkdirT(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('runPicker', () => {
  it('rejects when the wardrobe contains no outfits', async () => {
    const wardrobe = await mkdirT('picker-empty-');
    const userDir = await mkdirT('picker-empty-user-');
    const projectDir = await mkdirT('picker-empty-proj-');
    const dirs = { projectDir, userDir, builtinDir: wardrobe };

    const out: string[] = [];
    const err: string[] = [];
    await expect(
      runPicker(dirs, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }),
    ).rejects.toThrow(/no outfits found/);
  });
});
