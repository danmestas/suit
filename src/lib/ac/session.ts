/**
 * AC session orchestrator.
 *
 * An AC session is the lifecycle of a single `ac <harness> ...` invocation:
 * it composes the outfit/cut-filtered environment a downstream harness
 * (claude-code, codex, gemini, pi) sees, spawns the harness binary, and
 * tears the temp environment down on exit.
 *
 * Stages, in order:
 *   1. resolveTarget         — alias the harness name, fix discovery dirs
 *   2. persistResolution     — when filtered, compute + persist the resolution artifact
 *   3. prelaunchForTarget    — harness-specific tempdir / HOME-override composition
 *   4. exec                  — spawn the harness binary; cleanup on close
 *
 * The per-harness `prelaunchCompose*` helpers in `./prelaunch.ts` remain the
 * unit-test surface. This module concentrates the dispatch (which used to be a
 * six-branch else-if chain) into one switch with named stages.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { findOutfit } from '../outfit.js';
import { findCut } from '../cut.js';
import { findFit } from '../fit.js';
import { findAccessory } from '../accessory.js';
import { resolveAndPersist, resolveAgainstHarness, skillsKeepFromResolution } from '../resolution.js';
import { discoverComponents } from '../discover.js';
import { loadHarnessCatalog } from './harness-catalog.js';
import type { Target } from '../types.js';
import type { OutfitManifest, CutManifest, FitManifest, AccessoryManifest } from '../schema.js';
import type { GlobalsRegistry } from '../globals-schema.js';
import { loadGlobalsRegistry } from '../globals-loader.js';
import {
  prelaunchComposeClaudeCode,
  prelaunchComposeGemini,
  prelaunchComposePi,
  prelaunchComposeCodex,
} from './prelaunch.js';
import type { ParsedAcArgs } from './run.js';

export const HARNESS_ALIASES: Record<string, Target> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  gemini: 'gemini',
  pi: 'pi',
};

export interface AcSessionDeps {
  /** Override discovery roots (test injection). */
  projectDir?: string;
  userDir?: string;
  builtinDir?: string;
  /** Override real HOME dir used as source for prelaunch composition (test injection). */
  homeDir?: string;
  /** Override harness binary lookup (test injection). */
  resolveHarnessBin?: (harness: string) => string;
  /** Catalog provider (test injection). */
  loadCatalog?: () => Promise<any[]>;
  /** Hook called instead of execvp; used in tests to avoid replacing the process. */
  exec?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => never | Promise<number>;
}

/** Walk upward from `start` and return the directory containing the topmost `marker` file. */
export function findRepoRoot(start: string, marker = 'package.json'): string {
  let dir = path.resolve(start);
  let lastFound: string | null = null;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, marker))) lastFound = dir;
    dir = path.dirname(dir);
  }
  if (!lastFound) throw new Error(`findRepoRoot: no ${marker} found from ${start}`);
  return lastFound;
}

export function defaultResolveHarnessBin(harness: string): string {
  const target = HARNESS_ALIASES[harness];
  if (!target) throw new Error(`ac: unknown harness "${harness}"`);
  // The actual on-PATH binary differs from the target name in some cases.
  const binNames: Record<Target, string> = {
    'claude-code': 'claude',
    codex: 'codex',
    gemini: 'gemini',
    pi: 'pi',
  };
  return binNames[target];
}

interface PrelaunchInputs {
  target: Target;
  outfit?: OutfitManifest;
  fit?: FitManifest;
  cut?: CutManifest;
  accessories: AccessoryManifest[];
  cutBody?: string;
  fitBody?: string;
  resolutionArtifactPath?: string;
  realHome: string;
  globals?: GlobalsRegistry | null;
}

interface PrelaunchEffects {
  cwd?: string;
  envOverrides: NodeJS.ProcessEnv;
  cleanup?: () => Promise<void>;
}

/**
 * Single dispatch for the harness-specific prelaunch step. Returns the env
 * overrides, optional cwd override, and a cleanup hook the exec stage runs on
 * close. Replaces what used to be six near-identical else-if branches inline
 * in `runAc`.
 */
async function prelaunchForTarget(opts: PrelaunchInputs): Promise<PrelaunchEffects> {
  const { target, outfit, fit, cut, cutBody, fitBody, resolutionArtifactPath, realHome, globals } = opts;
  const filtered =
    outfit !== undefined ||
    fit !== undefined ||
    cut !== undefined ||
    opts.accessories.length > 0;

  switch (target) {
    case 'claude-code':
    case 'gemini':
    case 'pi': {
      if (!filtered) return { envOverrides: {} };
      const composer =
        target === 'claude-code'
          ? prelaunchComposeClaudeCode
          : target === 'gemini'
            ? prelaunchComposeGemini
            : prelaunchComposePi;
      const r = await composer({
        realHome,
        outfit,
        fit,
        cut,
        accessories: opts.accessories,
        cutBody,
        fitBody,
        globals,
      });
      return { envOverrides: { HOME: r.tempHome }, cleanup: r.cleanup };
    }
    case 'codex': {
      if (!resolutionArtifactPath) return { envOverrides: {} };
      // v0.8: when a globals registry is loaded AND the session is filtered,
      // also build a CODEX_HOME tempdir whose `config.toml` has non-kept
      // plugins/MCPs flipped to `enabled = false`. Skipped silently when no
      // globals registry is present (no semantic regression vs v0.7).
      let codexHomeFilter: { realCodexHome: string; skillsKeep: string[]; pluginsKeep?: string[]; mcpsKeep?: string[] } | undefined;
      if (globals && filtered) {
        const catalog = await loadHarnessCatalog('codex', opts.realHome);
        const resolution = await resolveAgainstHarness({
          target: 'codex',
          harnessHome: opts.realHome,
          outfit,
          fit,
          cut,
          accessories: opts.accessories,
          cutBody,
          fitBody,
          globals,
        });
        const skillsKeep = outfit || fit || cut
          ? skillsKeepFromResolution(catalog, resolution.skillsDrop)
          : catalog
              .filter((c: { manifest: { type: string; name: string } }) => c.manifest.type === 'skill')
              .map((c: { manifest: { type: string; name: string } }) => c.manifest.name);
        codexHomeFilter = {
          realCodexHome: process.env.CODEX_HOME ?? path.join(opts.realHome, '.codex'),
          skillsKeep,
          pluginsKeep: resolution.metadata.globals.plugins.kept,
          mcpsKeep: resolution.metadata.globals.mcps.kept,
        };
      }
      const r = await prelaunchComposeCodex({
        resolutionPath: resolutionArtifactPath,
        originalCwd: process.cwd(),
        codexHomeFilter,
      });
      const envOverrides: NodeJS.ProcessEnv = { AC_ORIGINAL_CWD: process.cwd() };
      if (r.codexHome) envOverrides.CODEX_HOME = r.codexHome;
      return {
        cwd: r.tempdir,
        envOverrides,
        cleanup: r.cleanup,
      };
    }
  }
}

export async function runAcSession(
  args: ParsedAcArgs,
  deps: AcSessionDeps = {},
): Promise<number> {
  // Stage 1: resolve target alias + discovery dirs.
  const target = HARNESS_ALIASES[args.harness];
  if (!target) {
    throw new Error(
      `ac: unknown harness "${args.harness}". Recognized: ${Object.keys(HARNESS_ALIASES).join(', ')}`,
    );
  }
  const projectDir = deps.projectDir ?? process.cwd();
  const userDir = deps.userDir ?? path.join(os.homedir(), '.config', 'agent-config');
  // session.ts lives at <repo>/src/lib/ac/session.ts — walk up to the repo
  // root where outfits/ and cuts/ live.
  const builtinDir = deps.builtinDir ?? findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const dirs = { projectDir, userDir, builtinDir };

  const env: NodeJS.ProcessEnv = { ...process.env, AC_WRAPPED: '1', AC_HARNESS: target };

  // Stage 2: load outfit/fit/cut/accessories and persist a resolution artifact
  // when filter is requested. `--no-filter` skips loading any of them per
  // ADR-0010 (treat the harness as if `suit` were not in the loop).
  const filtered =
    !args.noFilter &&
    (args.outfit !== undefined ||
      args.fit !== undefined ||
      args.cut !== undefined ||
      args.accessories.length > 0);
  let outfit: OutfitManifest | undefined;
  let fitManifest: FitManifest | undefined;
  let fitBody: string | undefined;
  let cutManifest: CutManifest | undefined;
  let cutBody: string | undefined;
  let accessoryManifests: AccessoryManifest[] = [];
  let resolutionArtifactPath: string | undefined;
  if (filtered) {
    if (args.outfit) outfit = (await findOutfit(args.outfit, dirs)).manifest;
    if (args.fit) {
      const found = await findFit(args.fit, dirs);
      fitManifest = found.manifest;
      fitBody = found.body;
    }
    if (args.cut) {
      const found = await findCut(args.cut, dirs);
      cutManifest = found?.manifest;
      cutBody = found?.body;
    }
    // Load accessories in CLI order — order is significant per ADR-0010 §3.
    for (const accName of args.accessories) {
      const found = await findAccessory(accName, dirs);
      accessoryManifests.push(found.manifest);
    }
    const catalog = await (deps.loadCatalog ?? (async () => discoverComponents(builtinDir)))();
    const { artifactPath } = await resolveAndPersist({
      catalog,
      outfit,
      fit: fitManifest,
      cut: cutManifest,
      accessories: accessoryManifests,
      cutBody,
      fitBody,
      harness: target,
    });
    resolutionArtifactPath = artifactPath;
    env.AC_RESOLUTION_PATH = artifactPath;
  }

  // v0.7+: load globals.yaml from the wardrobe builtin tier when present.
  // Missing file is non-fatal (returns null) — the resolver and prelaunch path
  // both treat null as "no globals filtering" and preserve v0.6 behavior.
  let globals: GlobalsRegistry | null = null;
  try {
    globals = await loadGlobalsRegistry(builtinDir);
  } catch (err) {
    // Malformed globals.yaml — surface to stderr and proceed without filtering
    // rather than refusing to launch the harness. The user's session is more
    // important than perfect globals targeting.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`suit: failed to load globals.yaml: ${msg}\n`);
  }

  // Stage 3: harness-specific prelaunch composition.
  const effects = await prelaunchForTarget({
    target,
    outfit,
    fit: fitManifest,
    cut: cutManifest,
    accessories: accessoryManifests,
    cutBody,
    fitBody,
    resolutionArtifactPath,
    realHome: deps.homeDir ?? os.homedir(),
    globals,
  });
  Object.assign(env, effects.envOverrides);
  const cwd = effects.cwd ?? process.cwd();

  // Stage 4: spawn the harness binary; tear down on close.
  const bin = (deps.resolveHarnessBin ?? defaultResolveHarnessBin)(args.harness);
  if (deps.exec) {
    return deps.exec(bin, args.harnessArgs, env);
  }
  // Real execution: spawn and inherit stdio. We cannot use execvp from Node
  // directly without an extra dep; spawning + forwarding signals + exiting
  // on close achieves the same outcome from the user's perspective.
  return new Promise<number>((resolveCb, reject) => {
    const child = spawn(bin, args.harnessArgs, { stdio: 'inherit', env, cwd });
    child.on('error', reject);
    child.on('close', async (code) => {
      if (effects.cleanup) await effects.cleanup();
      resolveCb(code ?? 0);
    });
  });
}
