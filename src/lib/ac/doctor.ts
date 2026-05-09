/**
 * `suit doctor` — health checks for a suit installation. Runs a battery of
 * passive checks (no mutation, no network) and reports per-check status with
 * pass / warn / fail. Exits 0 if no failures; 1 if any check failed.
 *
 * Per ADR-0014 §Consequences §Negative, `suit doctor` was named as the
 * planned mitigation for globals-registry drift. v0.12 ships the framework
 * + 5 initial checks; further checks (codex globals staleness, suit version
 * vs npm registry, orphan-bundle count) can layer on later.
 *
 * Design — straight-line, NOT a Check[] framework. Each check is a function
 * with the same return shape. `runDoctor` calls them via `Promise.all` and
 * formats results. If demand for pluggable checks materializes later, the
 * refactor to a registry is mechanical — but until that demand is real,
 * straight-line is the simpler design.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getHarnessPresence } from './harness-presence.js';
import { readLockfile } from '../lockfile.js';

export interface DoctorDeps {
  projectDir: string;
  contentDir: string;
  userDir: string;
  harnesses: string[];
  print: (line: string) => void;
}

type CheckResult = {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
};

async function checkContentPath(deps: DoctorDeps): Promise<CheckResult> {
  try {
    const stat = await fs.stat(deps.contentDir);
    if (!stat.isDirectory()) {
      return {
        name: 'content path',
        status: 'fail',
        message: `${deps.contentDir} exists but is not a directory`,
      };
    }
    return { name: 'content path', status: 'pass', message: deps.contentDir };
  } catch {
    return {
      name: 'content path',
      status: 'fail',
      message: `${deps.contentDir} does not exist (set SUIT_CONTENT_PATH or run 'suit init')`,
    };
  }
}

/**
 * Compare wardrobe globals.yaml mtime to user-side claude-code globals
 * (~/.claude/plugins/installed_plugins.json + ~/.claude.json). User-side
 * newer than the registry → drift → user has installed a plugin/MCP since
 * the last sync. This check is the v0.7 follow-through promised in ADR-0014.
 *
 * Skipped quietly when no globals.yaml exists (older wardrobe / pre-v0.7).
 */
async function checkGlobalsStaleness(deps: DoctorDeps): Promise<CheckResult> {
  const globalsYaml = path.join(deps.contentDir, 'globals.yaml');
  let globalsStat: import('node:fs').Stats;
  try {
    globalsStat = await fs.stat(globalsYaml);
  } catch {
    return {
      name: 'globals (claude)',
      status: 'pass',
      message: 'no globals.yaml — skip (run `suit-build sync-globals` to enable)',
    };
  }

  const userFiles = [
    path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'),
    path.join(os.homedir(), '.claude.json'),
  ];
  for (const userFile of userFiles) {
    try {
      const userStat = await fs.stat(userFile);
      if (userStat.mtimeMs > globalsStat.mtimeMs) {
        const days = Math.max(
          1,
          Math.round((userStat.mtimeMs - globalsStat.mtimeMs) / 86400000),
        );
        return {
          name: 'globals (claude)',
          status: 'warn',
          message: `drift: ${path.basename(userFile)} newer by ~${days}d — try \`suit-build sync-globals\``,
        };
      }
    } catch {
      // user file missing — normal on machines that don't have claude installed
    }
  }
  return {
    name: 'globals (claude)',
    status: 'pass',
    message: 'globals.yaml in sync with user-side',
  };
}

/**
 * If the project has a `.suit/lock.json`, every recorded file should still
 * exist on disk. Drift = half-applied state (someone deleted `.claude/` by
 * hand without `suit off`). Surface so the user knows to either re-up or
 * undress cleanly.
 */
async function checkLockfileConsistency(deps: DoctorDeps): Promise<CheckResult> {
  let lock;
  try {
    lock = await readLockfile(deps.projectDir);
  } catch (e) {
    return {
      name: 'lockfile',
      status: 'fail',
      message: `failed to read lockfile: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!lock) {
    return { name: 'lockfile', status: 'pass', message: 'no lockfile — project is undressed' };
  }
  let missing = 0;
  const total = lock.files.length;
  for (const entry of lock.files) {
    try {
      await fs.access(path.join(deps.projectDir, entry.path));
    } catch {
      missing++;
    }
  }
  if (missing > 0) {
    return {
      name: 'lockfile',
      status: 'fail',
      message: `${missing}/${total} recorded paths missing on disk — run \`suit off && suit up\``,
    };
  }
  return {
    name: 'lockfile',
    status: 'pass',
    message: `consistent (${total}/${total} paths exist)`,
  };
}

/**
 * If contentDir is a git repo, check FETCH_HEAD mtime as a proxy for "when
 * did we last `suit sync`". 14+ days = warn. Not a git repo (e.g. local
 * untracked content) = skip.
 */
async function checkWardrobeFreshness(deps: DoctorDeps): Promise<CheckResult> {
  const gitDir = path.join(deps.contentDir, '.git');
  try {
    await fs.access(gitDir);
  } catch {
    return {
      name: 'wardrobe staleness',
      status: 'pass',
      message: 'not a git repo — skip',
    };
  }
  const fetchHead = path.join(gitDir, 'FETCH_HEAD');
  try {
    const stat = await fs.stat(fetchHead);
    const days = Math.floor((Date.now() - stat.mtimeMs) / 86400000);
    if (days >= 14) {
      return {
        name: 'wardrobe staleness',
        status: 'warn',
        message: `last fetched ${days}d ago — try \`suit sync\``,
      };
    }
    return {
      name: 'wardrobe staleness',
      status: 'pass',
      message: `last fetched ${days}d ago`,
    };
  } catch {
    // No FETCH_HEAD: git repo exists but never fetched. Probably a local
    // clone without remote sync — that's fine.
    return {
      name: 'wardrobe staleness',
      status: 'pass',
      message: 'no FETCH_HEAD (clean clone or never fetched) — fine',
    };
  }
}

/**
 * Harness presence — preserves the v0 doctor contract: every requested
 * harness must be on PATH. Missing → fail. Users who don't want this
 * narrow gate can pass an empty harness list.
 *
 * Future: a `--soft-harnesses` flag could downgrade missing-harness to
 * warn for users who have only some of claude/codex/gemini installed.
 * Out of scope for v0.12; would change exit-code semantics.
 */
async function checkHarnesses(deps: DoctorDeps): Promise<CheckResult[]> {
  const presence = getHarnessPresence(deps.harnesses);
  return presence.map((p) => ({
    name: `harness: ${p.harness}`,
    status: p.found ? ('pass' as const) : ('fail' as const),
    message: p.found && p.binPath ? p.binPath : 'not found on PATH',
  }));
}

const SYM: Record<CheckResult['status'], string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
};

export async function runDoctor(deps: DoctorDeps): Promise<number> {
  // All checks run in parallel — none depend on the others. Each catches
  // its own errors internally and returns a result; runDoctor never throws.
  const [contentPath, globals, lockfile, wardrobe, harnesses] = await Promise.all([
    checkContentPath(deps),
    checkGlobalsStaleness(deps),
    checkLockfileConsistency(deps),
    checkWardrobeFreshness(deps),
    checkHarnesses(deps),
  ]);

  const all: CheckResult[] = [contentPath, globals, lockfile, wardrobe, ...harnesses];
  const NAME_W = 26;

  for (const r of all) {
    deps.print(`${SYM[r.status]} ${r.name.padEnd(NAME_W)} ${r.message}`);
  }

  const failures = all.filter((r) => r.status === 'fail').length;
  const warnings = all.filter((r) => r.status === 'warn').length;
  deps.print('');
  deps.print(
    `${warnings} warning${warnings !== 1 ? 's' : ''}, ${failures} failure${failures !== 1 ? 's' : ''}.`,
  );
  return failures > 0 ? 1 : 0;
}
