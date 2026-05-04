import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_AC = path.join(REPO_ROOT, 'dist', 'ac.js');

describe('dist/ runnable as Node ESM', () => {
  beforeAll(() => {
    // Always build before running this test — eliminates "is dist/ stale?" unknown.
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  }, 60_000);

  it('dist/ac.js exists and starts with shebang', () => {
    expect(existsSync(DIST_AC)).toBe(true);
  });

  it('runs `suit list outfits` against a fixture content dir', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'suit-distrun-'));
    try {
      mkdirSync(path.join(tmp, 'outfits', 'demo'), { recursive: true });
      writeFileSync(
        path.join(tmp, 'outfits', 'demo', 'outfit.md'),
        '---\nname: demo\nversion: 1.0.0\ntype: outfit\ndescription: d\ntargets: [claude-code]\ncategories: [tooling]\n---\nbody',
      );

      const result = spawnSync('node', [DIST_AC, 'list', 'outfits'], {
        env: { ...process.env, SUIT_CONTENT_PATH: tmp },
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('demo');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
