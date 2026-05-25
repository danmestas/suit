import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInject, reloadDecision } from '../../lib/ac/inject.js';
import { runCurrent } from '../../lib/ac/current.js';
import { readLockfile, writeLockfile, sha256OfBuffer, type Lockfile } from '../../lib/lockfile.js';

const cleanupQueue: string[] = [];
afterEach(async () => {
  while (cleanupQueue.length > 0) {
    const dir = cleanupQueue.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function mkdirT(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupQueue.push(dir);
  return dir;
}

/**
 * Wardrobe with an authored accessory `release` whose include block lists a
 * single skill `release-watch`, plus the skill itself. Targets default to
 * claude-code so the claude-code adapter is exercised and files land under
 * `.claude/skills/...`.
 */
async function mkWardrobe(): Promise<string> {
  const root = await mkdirT('suit-inject-wardrobe-');

  await fs.mkdir(path.join(root, 'accessories', 'release'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'accessories', 'release', 'accessory.md'),
    `---
name: release
version: 1.0.0
type: accessory
description: release watching bundle
targets: [claude-code]
include:
  skills: [release-watch]
---
release bundle body
`,
  );

  await fs.mkdir(path.join(root, 'skills', 'release-watch'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'skills', 'release-watch', 'SKILL.md'),
    `---
name: release-watch
version: 1.0.0
type: skill
description: watch a release flow
targets: [claude-code]
---
release-watch body
`,
  );

  return root;
}

/**
 * Wardrobe whose accessory `philosophy` includes a project-scope rules
 * component. The claude-code adapter emits project-scope rules into an additive
 * CLAUDE.md — exactly the file class that defeated the old on-disk idempotency
 * scan (BUG 1). A re-inject must still report `unchanged` despite the additive
 * file's whole-file sha differing (the host file mixes our block with whatever
 * else is there). This mirrors the real `philosophy` accessory in the wardrobe.
 */
async function mkWardrobeWithAdditive(): Promise<string> {
  const root = await mkdirT('suit-inject-additive-');

  await fs.mkdir(path.join(root, 'accessories', 'philosophy'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'accessories', 'philosophy', 'accessory.md'),
    `---
name: philosophy
version: 1.0.0
type: accessory
description: philosophy bundle with a rule
targets: [claude-code]
include:
  rules: [norman]
---
philosophy bundle body
`,
  );

  await fs.mkdir(path.join(root, 'rules', 'norman'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'rules', 'norman', 'RULE.md'),
    `---
name: norman
version: 1.0.0
type: rules
description: design discipline rule
targets: [claude-code]
scope: project
---
Norman's design principles apply to every interface.
`,
  );

  return root;
}

interface Capture {
  out: string[];
  err: string[];
  push: (s: string) => void;
  pushE: (s: string) => void;
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, push: (s) => out.push(s), pushE: (s) => err.push(s) };
}

const SKILL_PATH = '.claude/skills/release-watch/SKILL.md';

describe('runInject — materialize + lockfile', () => {
  it('writes the accessory files under --home and records them in injected[]', async () => {
    const wardrobe = await mkWardrobe();
    const home = await mkdirT('suit-inject-home-');
    const userDir = await mkdirT('suit-inject-user-');
    const cap = capture();

    const code = await runInject(
      {
        component: 'release',
        home,
        contentDir: wardrobe,
        userDir,
        dryRun: false,
        noReload: false,
        force: false,
        json: false,
      },
      { stdout: cap.push, stderr: cap.pushE },
    );

    expect(cap.err.join('')).toBe('');
    expect(code).toBe(0);

    // The skill landed at the expected claude-code path.
    const stat = await fs.stat(path.join(home, SKILL_PATH));
    expect(stat.isFile()).toBe(true);

    // Lockfile records the injection (not the up `files`/`resolution`).
    const lock = await readLockfile(home);
    expect(lock).not.toBeNull();
    expect(lock!.files).toEqual([]);
    expect(lock!.resolution).toEqual({ outfit: null, cut: null, accessories: [] });
    expect(lock!.injected).toHaveLength(1);
    const inj = lock!.injected![0];
    expect(inj.component).toBe('release');
    expect(typeof inj.injectedAt).toBe('string');
    expect(inj.files.some((f) => f.path === SKILL_PATH)).toBe(true);

    // Recorded sha matches the on-disk file.
    const skillEntry = inj.files.find((f) => f.path === SKILL_PATH)!;
    const onDisk = await fs.readFile(path.join(home, SKILL_PATH));
    expect(sha256OfBuffer(onDisk)).toBe(skillEntry.sha256);

    // Output reports status, reload decision (skill → not-required), targets.
    const out = cap.out.join('');
    expect(out).toMatch(/injected: release/);
    expect(out).toMatch(/reload:\s+not-required/);
  });

  it('is idempotent: re-injecting the same component is unchanged with no lockfile mutation', async () => {
    const wardrobe = await mkWardrobe();
    const home = await mkdirT('suit-inject-home-');
    const userDir = await mkdirT('suit-inject-user-');

    const c1 = capture();
    await runInject(
      { component: 'release', home, contentDir: wardrobe, userDir, dryRun: false, noReload: false, force: false, json: false },
      { stdout: c1.push, stderr: c1.pushE },
    );
    const lock1 = await readLockfile(home);
    const at1 = lock1!.injected![0].injectedAt;
    // Capture file + lockfile mtimes so we can prove the second run writes nothing.
    const skillMtime1 = (await fs.stat(path.join(home, SKILL_PATH))).mtimeMs;
    const lockMtime1 = (await fs.stat(path.join(home, '.suit', 'lock.json'))).mtimeMs;

    await new Promise((r) => setTimeout(r, 10));

    const c2 = capture();
    const code = await runInject(
      { component: 'release', home, contentDir: wardrobe, userDir, dryRun: false, noReload: false, force: false, json: false },
      { stdout: c2.push, stderr: c2.pushE },
    );

    expect(code).toBe(0);
    expect(c2.out.join('')).toMatch(/unchanged: release/);
    // Lockfile injected entry unchanged — no rewrite, timestamp preserved.
    const lock2 = await readLockfile(home);
    expect(lock2!.injected![0].injectedAt).toBe(at1);
    // Nothing on disk was rewritten: skill file and lockfile mtimes unchanged.
    expect((await fs.stat(path.join(home, SKILL_PATH))).mtimeMs).toBe(skillMtime1);
    expect((await fs.stat(path.join(home, '.suit', 'lock.json'))).mtimeMs).toBe(lockMtime1);
  });

  it('is idempotent for accessories that emit additive files (BUG 1 regression)', async () => {
    // The exact case that defeated the old whole-file on-disk scan: the
    // accessory emits an additive CLAUDE.md whose whole-file sha differs from
    // the recorded BLOCK sha. The fix compares freshly-computed lock-entries
    // (block sha for additive) against the prior injected entry, so re-inject
    // is correctly `unchanged`.
    const wardrobe = await mkWardrobeWithAdditive();
    const home = await mkdirT('suit-inject-home-');
    const userDir = await mkdirT('suit-inject-user-');

    const c1 = capture();
    const code1 = await runInject(
      { component: 'philosophy', home, contentDir: wardrobe, userDir, dryRun: false, noReload: false, force: false, json: false },
      { stdout: c1.push, stderr: c1.pushE },
    );
    expect(c1.err.join('')).toBe('');
    expect(code1).toBe(0);
    expect(c1.out.join('')).toMatch(/injected: philosophy/);

    // Sanity: an additive CLAUDE.md was emitted, and its lockfile entry records
    // mode 'additive' (block sha, not whole-file sha).
    const lock1 = await readLockfile(home);
    const additive = lock1!.injected![0].files.find((f) => f.mode === 'additive');
    expect(additive).toBeDefined();
    const claudeMtime1 = (await fs.stat(path.join(home, additive!.path))).mtimeMs;
    const at1 = lock1!.injected![0].injectedAt;

    await new Promise((r) => setTimeout(r, 10));

    const c2 = capture();
    const code2 = await runInject(
      { component: 'philosophy', home, contentDir: wardrobe, userDir, dryRun: false, noReload: false, force: false, json: false },
      { stdout: c2.push, stderr: c2.pushE },
    );
    expect(code2).toBe(0);
    // The regression: this MUST be 'unchanged', not 'injected'.
    expect(c2.out.join('')).toMatch(/unchanged: philosophy/);
    const lock2 = await readLockfile(home);
    expect(lock2!.injected![0].injectedAt).toBe(at1);
    expect((await fs.stat(path.join(home, additive!.path))).mtimeMs).toBe(claudeMtime1);
  });

  it('refuses when a target file exists untracked, and --force overrides', async () => {
    const wardrobe = await mkWardrobe();
    const home = await mkdirT('suit-inject-home-');
    const userDir = await mkdirT('suit-inject-user-');

    // Hand-create an untracked file at the inject target path.
    await fs.mkdir(path.dirname(path.join(home, SKILL_PATH)), { recursive: true });
    await fs.writeFile(path.join(home, SKILL_PATH), 'hand-authored');

    const c1 = capture();
    const refused = await runInject(
      { component: 'release', home, contentDir: wardrobe, userDir, dryRun: false, noReload: false, force: false, json: false },
      { stdout: c1.push, stderr: c1.pushE },
    );
    expect(refused).toBe(1);
    expect(c1.err.join('')).toMatch(/not suit-managed/);
    expect(await readLockfile(home)).toBeNull();

    const c2 = capture();
    const forced = await runInject(
      { component: 'release', home, contentDir: wardrobe, userDir, dryRun: false, noReload: false, force: true, json: false },
      { stdout: c2.push, stderr: c2.pushE },
    );
    expect(forced).toBe(0);
    const lock = await readLockfile(home);
    expect(lock!.injected![0].files.some((f) => f.path === SKILL_PATH)).toBe(true);
  });

  it('creates a minimal lockfile when none exists', async () => {
    const wardrobe = await mkWardrobe();
    const home = await mkdirT('suit-inject-home-');
    const userDir = await mkdirT('suit-inject-user-');

    expect(await readLockfile(home)).toBeNull();

    const cap = capture();
    await runInject(
      { component: 'release', home, contentDir: wardrobe, userDir, dryRun: false, noReload: false, force: false, json: false },
      { stdout: cap.push, stderr: cap.pushE },
    );

    const lock = await readLockfile(home);
    expect(lock).not.toBeNull();
    expect(lock!.schemaVersion).toBe(1);
    expect(lock!.resolution).toEqual({ outfit: null, cut: null, accessories: [] });
    expect(lock!.files).toEqual([]);
    expect(lock!.injected).toHaveLength(1);
  });

  it('preserves a prior up-applied lockfile and only touches injected[]', async () => {
    const wardrobe = await mkWardrobe();
    const home = await mkdirT('suit-inject-home-');
    const userDir = await mkdirT('suit-inject-user-');

    // Seed an up-style lockfile with files + resolution.
    const seeded: Lockfile = {
      schemaVersion: 1,
      appliedAt: '2026-05-04T00:00:00Z',
      resolution: { outfit: 'engineer', cut: null, accessories: ['pr-policy'] },
      files: [{ path: '.claude/CLAUDE.md', sha256: 'a'.repeat(64), sourceComponent: 'outfits/engineer' }],
    };
    await writeLockfile(home, seeded);

    const cap = capture();
    await runInject(
      { component: 'release', home, contentDir: wardrobe, userDir, dryRun: false, noReload: false, force: false, json: false },
      { stdout: cap.push, stderr: cap.pushE },
    );

    const lock = await readLockfile(home);
    expect(lock!.resolution).toEqual(seeded.resolution);
    expect(lock!.files).toEqual(seeded.files);
    expect(lock!.injected).toHaveLength(1);
    expect(lock!.injected![0].component).toBe('release');
  });

  it('--dry-run resolves and reports without writing files or lockfile', async () => {
    const wardrobe = await mkWardrobe();
    const home = await mkdirT('suit-inject-home-');
    const userDir = await mkdirT('suit-inject-user-');

    const cap = capture();
    const code = await runInject(
      { component: 'release', home, contentDir: wardrobe, userDir, dryRun: true, noReload: false, force: false, json: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(code).toBe(0);
    expect(cap.out.join('')).toMatch(/dry-run: release/);
    await expect(fs.stat(path.join(home, SKILL_PATH))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readLockfile(home)).toBeNull();
  });

  it('--no-reload reports the reload as skipped', async () => {
    const wardrobe = await mkWardrobe();
    const home = await mkdirT('suit-inject-home-');
    const userDir = await mkdirT('suit-inject-user-');

    const cap = capture();
    await runInject(
      { component: 'release', home, contentDir: wardrobe, userDir, dryRun: false, noReload: true, force: false, json: false },
      { stdout: cap.push, stderr: cap.pushE },
    );
    expect(cap.out.join('')).toMatch(/reload:\s+skipped/);
  });

  it('--json emits a machine-readable result', async () => {
    const wardrobe = await mkWardrobe();
    const home = await mkdirT('suit-inject-home-');
    const userDir = await mkdirT('suit-inject-user-');

    const cap = capture();
    await runInject(
      { component: 'release', home, contentDir: wardrobe, userDir, dryRun: false, noReload: false, force: false, json: true },
      { stdout: cap.push, stderr: cap.pushE },
    );
    const parsed = JSON.parse(cap.out.join(''));
    expect(parsed.status).toBe('injected');
    expect(parsed.component).toBe('release');
    expect(parsed.reload).toBe('not-required');
    expect(parsed.targets).toContain('claude-code');
  });
});

describe('reloadDecision', () => {
  it('claude-code skill → not-required', () => {
    expect(reloadDecision('claude-code', new Set(['skill']))).toBe('not-required');
  });
  it('claude-code hook/agent/rules → not-required', () => {
    expect(reloadDecision('claude-code', new Set(['hook', 'agent', 'rules']))).toBe('not-required');
  });
  it('claude-code mcp → restart-required', () => {
    expect(reloadDecision('claude-code', new Set(['mcp']))).toBe('restart-required');
  });
  it('claude-code plugin → restart-required', () => {
    expect(reloadDecision('claude-code', new Set(['plugin']))).toBe('restart-required');
  });
  it('claude-code mixed (skill + mcp) → restart-required', () => {
    expect(reloadDecision('claude-code', new Set(['skill', 'mcp']))).toBe('restart-required');
  });
  it('codex anything → restart-required', () => {
    expect(reloadDecision('codex', new Set(['skill']))).toBe('restart-required');
  });
  it('gemini anything → restart-required', () => {
    expect(reloadDecision('gemini', new Set(['skill']))).toBe('restart-required');
  });
  it('pi anything → restart-required', () => {
    expect(reloadDecision('pi', new Set(['skill']))).toBe('restart-required');
  });
});

describe('runCurrent — injected awareness', () => {
  it('shows injected entries distinctly', async () => {
    const home = await mkdirT('suit-current-inj-');
    const body = '# foo\n';
    const filePath = '.claude/skills/release-watch/SKILL.md';
    await fs.mkdir(path.dirname(path.join(home, filePath)), { recursive: true });
    await fs.writeFile(path.join(home, filePath), body);
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: '2026-05-04T00:00:00Z',
      resolution: { outfit: null, cut: null, accessories: [] },
      files: [],
      injected: [
        {
          component: 'release',
          injectedAt: '2026-05-24T00:51:00Z',
          files: [{ path: filePath, sha256: sha256OfBuffer(body), sourceComponent: 'skills/release-watch' }],
        },
      ],
    };
    await writeLockfile(home, lock);

    const cap = capture();
    const code = await runCurrent({ projectDir: home }, { stdout: cap.push, stderr: cap.pushE });
    expect(code).toBe(0);
    const out = cap.out.join('');
    expect(out).toMatch(/injected \(1\)/);
    expect(out).toMatch(/\+ release \(injected 2026-05-24T00:51:00Z, 1 file\)/);
  });

  it('is unchanged when there are no injected entries', async () => {
    const home = await mkdirT('suit-current-noinj-');
    const lock: Lockfile = {
      schemaVersion: 1,
      appliedAt: '2026-05-04T00:00:00Z',
      resolution: { outfit: 'backend', cut: null, accessories: [] },
      files: [],
    };
    await writeLockfile(home, lock);

    const cap = capture();
    await runCurrent({ projectDir: home }, { stdout: cap.push, stderr: cap.pushE });
    expect(cap.out.join('')).not.toMatch(/injected/);
  });
});
