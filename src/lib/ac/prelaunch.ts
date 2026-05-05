import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TempdirWriter, type Writer } from '../writer.js';

export interface PrelaunchOptions {
  resolutionPath: string;
  originalCwd: string;
  /**
   * Sink for emitted files. Defaults to a fresh `TempdirWriter` (today's
   * behavior). Phase B's `suit up` will pass a `ProjectWriter` rooted at the
   * project to write the same artifacts straight into the project tree.
   */
  writer?: Writer;
}

export interface PrelaunchResult {
  tempdir: string;
  /** Cleanup function — call on session end. Best-effort. */
  cleanup: () => Promise<void>;
}

/**
 * Run `suit-build docs ...` and capture its output into a Buffer rather than
 * a fixed file path, so the result can be routed through a Writer (tempdir or
 * project).
 *
 * Implemented by writing `suit-build`'s output to a tempfile, reading it back,
 * and removing the tempfile. We can't easily ask `suit-build docs` to emit to
 * stdout without changing its CLI, so this is the smallest-surface change.
 */
async function buildDocsToBuffer(
  target: 'codex' | 'copilot',
  resolutionPath: string,
  originalCwd: string,
): Promise<Buffer> {
  const tmpOut = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ac-build-out-')),
    'out.md',
  );
  try {
    await new Promise<void>((resolveCb, reject) => {
      const child = spawn(
        'suit-build',
        ['docs', '--target', target, '--resolution', resolutionPath, '--out', tmpOut, '--repo', originalCwd],
        { stdio: 'inherit' },
      );
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolveCb() : reject(new Error(`suit-build docs exited ${code}`))));
    });
    return await fs.readFile(tmpOut);
  } finally {
    await fs.rm(path.dirname(tmpOut), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Symlink common project files into the writer destination so the harness
 * (codex/copilot, which run with cwd=tempdir) can still see them.
 */
async function symlinkProjectFiles(originalCwd: string, writer: Writer): Promise<void> {
  const toLink = ['.git', 'package.json', 'tsconfig.json', '.env'];
  for (const name of toLink) {
    const src = path.join(originalCwd, name);
    try {
      await fs.access(src);
      await writer.symlink(src, name);
    } catch {
      // skip missing
    }
  }
}

export async function prelaunchComposeCodex(opts: PrelaunchOptions): Promise<PrelaunchResult> {
  const writer = opts.writer ?? (await TempdirWriter.create());
  const content = await buildDocsToBuffer('codex', opts.resolutionPath, opts.originalCwd);
  await writer.write({ path: 'AGENTS.md', content });
  await symlinkProjectFiles(opts.originalCwd, writer);
  return {
    tempdir: writer.destination,
    cleanup: writer.cleanup ?? (async () => {}),
  };
}

export async function prelaunchComposeCopilot(opts: PrelaunchOptions): Promise<PrelaunchResult> {
  const writer = opts.writer ?? (await TempdirWriter.create());
  const content = await buildDocsToBuffer('copilot', opts.resolutionPath, opts.originalCwd);
  await writer.write({ path: 'copilot-instructions.md', content });
  await symlinkProjectFiles(opts.originalCwd, writer);
  return {
    tempdir: writer.destination,
    cleanup: writer.cleanup ?? (async () => {}),
  };
}

import { resolveAgainstHarness, skillsKeepFromResolution } from '../resolution.js';
import { composeHarnessHome } from './symlink-farm.js';
import { loadHarnessCatalog } from './harness-catalog.js';
import type { OutfitManifest, ModeManifest, AccessoryManifest } from '../schema.js';
import type { GlobalsRegistry } from '../globals-schema.js';

export interface HomeOverridePrelaunchOptions {
  realHome: string;
  outfit?: OutfitManifest;
  mode?: ModeManifest;
  accessories?: AccessoryManifest[];
  modeBody?: string;
  /** v0.7+: optional globals registry for plugin/mcp filtering. */
  globals?: GlobalsRegistry | null;
}

/** @deprecated Use HomeOverridePrelaunchOptions */
export type ClaudePrelaunchOptions = HomeOverridePrelaunchOptions;

async function composeWithHomeOverride(
  target: 'claude-code' | 'gemini' | 'pi',
  opts: HomeOverridePrelaunchOptions,
): Promise<{ tempHome: string; cleanup: () => Promise<void> }> {
  const catalog = await loadHarnessCatalog(target, opts.realHome);
  const resolution = await resolveAgainstHarness({
    target,
    harnessHome: opts.realHome,
    outfit: opts.outfit,
    mode: opts.mode,
    accessories: opts.accessories,
    modeBody: opts.modeBody,
    globals: opts.globals,
  });
  const skillsKeep = opts.outfit || opts.mode
    ? skillsKeepFromResolution(catalog, resolution.skillsDrop)
    : catalog.filter((c) => c.manifest.type === 'skill').map((c) => c.manifest.name); // no filter → keep all
  // Only forward plugins/mcps filtering when a globals registry was provided —
  // otherwise composeHarnessHome falls through to the v0.6 symlink-everything
  // path, which is the contract preserved for callers without globals.yaml.
  const pluginsKeep = opts.globals && target === 'claude-code'
    ? resolution.metadata.globals.plugins.kept
    : undefined;
  const mcpsKeep = opts.globals && target === 'claude-code'
    ? resolution.metadata.globals.mcps.kept
    : undefined;
  return composeHarnessHome({
    target,
    realHome: opts.realHome,
    skillsKeep,
    pluginsKeep,
    mcpsKeep,
  });
}

export async function prelaunchComposeClaudeCode(
  opts: HomeOverridePrelaunchOptions,
): Promise<{ tempHome: string; cleanup: () => Promise<void> }> {
  return composeWithHomeOverride('claude-code', opts);
}

export async function prelaunchComposeGemini(
  opts: HomeOverridePrelaunchOptions,
): Promise<{ tempHome: string; cleanup: () => Promise<void> }> {
  return composeWithHomeOverride('gemini', opts);
}

export async function prelaunchComposePi(
  opts: HomeOverridePrelaunchOptions,
): Promise<{ tempHome: string; cleanup: () => Promise<void> }> {
  return composeWithHomeOverride('pi', opts);
}

export interface ApmPrelaunchOptions {
  /** APM package root, typically process.cwd() of the user's invocation. */
  packageDir: string;
  outfit?: OutfitManifest;
  mode?: ModeManifest;
  modeBody?: string;
}

/**
 * Build a filtered tempdir mirroring the APM package at `packageDir`.
 * All files/dirs except `.apm/skills/` are symlinked through.
 * Only outfit-allowed skills are symlinked into `.apm/skills/`.
 * Returns `tempPackageDir` — set `APM_PACKAGE_DIR=tempPackageDir` before launching apm.
 */
export async function prelaunchComposeApm(opts: ApmPrelaunchOptions): Promise<{
  tempPackageDir: string;
  cleanup: () => Promise<void>;
}> {
  const catalog = await loadHarnessCatalog('apm', opts.packageDir);
  const resolution = await resolveAgainstHarness({
    target: 'apm',
    harnessHome: opts.packageDir,
    outfit: opts.outfit,
    mode: opts.mode,
    modeBody: opts.modeBody,
  });
  const skillsKeep = opts.outfit || opts.mode
    ? skillsKeepFromResolution(catalog, resolution.skillsDrop)
    : catalog.filter((c) => c.manifest.type === 'skill').map((c) => c.manifest.name);

  // Build a tempdir that mirrors packageDir but with a curated .apm/skills/
  const tempPackageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-apm-'));
  const apmSubdir = '.apm';
  const skillsSubdir = 'skills';

  // Symlink all top-level entries except .apm/
  let topEntries: string[] = [];
  try {
    topEntries = await fs.readdir(opts.packageDir);
  } catch {
    // packageDir unreadable — proceed with empty tempdir
  }
  for (const entry of topEntries) {
    if (entry === apmSubdir) continue;
    const src = path.join(opts.packageDir, entry);
    const dest = path.join(tempPackageDir, entry);
    await fs.symlink(src, dest);
  }

  // Build .apm/ mirroring all entries except skills/
  const realApmDir = path.join(opts.packageDir, apmSubdir);
  const tempApmDir = path.join(tempPackageDir, apmSubdir);
  await fs.mkdir(tempApmDir, { recursive: true });
  let apmEntries: string[] = [];
  try {
    apmEntries = await fs.readdir(realApmDir);
  } catch {
    // No .apm dir — leave tempApmDir mostly empty
  }
  for (const entry of apmEntries) {
    if (entry === skillsSubdir) continue;
    const src = path.join(realApmDir, entry);
    const dest = path.join(tempApmDir, entry);
    await fs.symlink(src, dest);
  }

  // Build curated .apm/skills/ with only allowed skills
  const tempSkillsDir = path.join(tempApmDir, skillsSubdir);
  await fs.mkdir(tempSkillsDir);
  const realSkillsDir = path.join(realApmDir, skillsSubdir);
  for (const skillName of skillsKeep) {
    const src = path.join(realSkillsDir, skillName);
    const dest = path.join(tempSkillsDir, skillName);
    try {
      await fs.access(src);
      await fs.symlink(src, dest);
    } catch {
      // Skill in keep list doesn't exist — skip silently
    }
  }

  return {
    tempPackageDir,
    cleanup: async () => {
      try {
        await fs.rm(tempPackageDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
