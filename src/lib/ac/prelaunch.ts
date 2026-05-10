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
  /**
   * v0.8: when set, also build a filtered `CODEX_HOME` tempdir mirroring the
   * user's real codex home with `config.toml` rewritten to disable plugins/MCPs
   * outside the kept-sets. Optional — older callers that don't pass globals
   * filtering get `codexHome: undefined` and behave exactly as v0.7.
   */
  codexHomeFilter?: {
    realCodexHome: string;
    skillsKeep: string[];
    pluginsKeep?: string[];
    mcpsKeep?: string[];
  };
}

export interface PrelaunchResult {
  tempdir: string;
  /**
   * v0.8: tempdir to set as `CODEX_HOME` when spawning codex, when the caller
   * requested `codexHomeFilter`. Undefined in the no-filter path.
   */
  codexHome?: string;
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
  target: 'codex',
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
 * (codex, which runs with cwd=tempdir) can still see them.
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

  // v0.8: optional CODEX_HOME composition. The project-cwd tempdir (above)
  // and the CODEX_HOME tempdir are intentionally separate — one carries
  // AGENTS.md and project files (becomes the spawn cwd), the other carries
  // the codex config + filtered plugins/MCPs (becomes $CODEX_HOME). They
  // serve different roles and codex consumes them via different mechanisms.
  let codexHome: string | undefined;
  let codexHomeCleanup: (() => Promise<void>) | undefined;
  if (opts.codexHomeFilter) {
    const r = await composeCodexHome({
      realCodexHome: opts.codexHomeFilter.realCodexHome,
      skillsKeep: opts.codexHomeFilter.skillsKeep,
      pluginsKeep: opts.codexHomeFilter.pluginsKeep,
      mcpsKeep: opts.codexHomeFilter.mcpsKeep,
    });
    codexHome = r.tempCodexHome;
    codexHomeCleanup = r.cleanup;
  }

  const cwdCleanup = writer.cleanup ?? (async () => {});
  return {
    tempdir: writer.destination,
    codexHome,
    cleanup: async () => {
      // Chain both cleanups; failure in one shouldn't block the other.
      await cwdCleanup().catch(() => {});
      if (codexHomeCleanup) await codexHomeCleanup().catch(() => {});
    },
  };
}

import { resolveAgainstHarness, skillsKeepFromResolution } from '../resolution.js';
import { composeHarnessHome } from './symlink-farm.js';
import { composeCodexHome } from './codex-home.js';
import { loadHarnessCatalog } from './harness-catalog.js';
import type { OutfitManifest, CutManifest, AccessoryManifest } from '../schema.js';
import type { GlobalsRegistry } from '../globals-schema.js';

export interface HomeOverridePrelaunchOptions {
  realHome: string;
  outfit?: OutfitManifest;
  cut?: CutManifest;
  accessories?: AccessoryManifest[];
  cutBody?: string;
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
    cut: opts.cut,
    accessories: opts.accessories,
    cutBody: opts.cutBody,
    globals: opts.globals,
  });
  const skillsKeep = opts.outfit || opts.cut
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

