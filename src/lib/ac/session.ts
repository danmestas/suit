/**
 * AC session orchestrator.
 *
 * An AC session is the lifecycle of a single `ac <harness> ...` invocation:
 * it composes the outfit/mode-filtered environment a downstream harness
 * (claude-code, gemini, pi, apm, codex, copilot) sees, spawns the harness
 * binary, and tears the temp environment down on exit.
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
import { findMode } from '../mode.js';
import { resolveAndPersist } from '../resolution.js';
import { discoverComponents } from '../discover.js';
import type { Target } from '../types.js';
import type { OutfitManifest, ModeManifest } from '../schema.js';
import {
  prelaunchComposeClaudeCode,
  prelaunchComposeGemini,
  prelaunchComposePi,
  prelaunchComposeCodex,
  prelaunchComposeCopilot,
  prelaunchComposeApm,
} from './prelaunch.js';
import type { ParsedAcArgs } from './run.js';

export const HARNESS_ALIASES: Record<string, Target> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  apm: 'apm',
  codex: 'codex',
  gemini: 'gemini',
  copilot: 'copilot',
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
    apm: 'apm',
    codex: 'codex',
    gemini: 'gemini',
    copilot: 'copilot',
    pi: 'pi',
  };
  return binNames[target];
}

interface PrelaunchInputs {
  target: Target;
  outfit?: OutfitManifest;
  mode?: ModeManifest;
  modeBody?: string;
  resolutionArtifactPath?: string;
  realHome: string;
  apmPackageDir: string;
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
  const { target, outfit, mode, modeBody, resolutionArtifactPath, realHome, apmPackageDir } = opts;
  const filtered = outfit !== undefined || mode !== undefined;

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
      const r = await composer({ realHome, outfit, mode, modeBody });
      return { envOverrides: { HOME: r.tempHome }, cleanup: r.cleanup };
    }
    case 'apm': {
      if (!filtered) return { envOverrides: {} };
      const r = await prelaunchComposeApm({ packageDir: apmPackageDir, outfit, mode, modeBody });
      return { envOverrides: { APM_PACKAGE_DIR: r.tempPackageDir }, cleanup: r.cleanup };
    }
    case 'codex': {
      if (!resolutionArtifactPath) return { envOverrides: {} };
      const r = await prelaunchComposeCodex({
        resolutionPath: resolutionArtifactPath,
        originalCwd: process.cwd(),
      });
      return {
        cwd: r.tempdir,
        envOverrides: { AC_ORIGINAL_CWD: process.cwd() },
        cleanup: r.cleanup,
      };
    }
    case 'copilot': {
      if (!resolutionArtifactPath) return { envOverrides: {} };
      const r = await prelaunchComposeCopilot({
        resolutionPath: resolutionArtifactPath,
        originalCwd: process.cwd(),
      });
      return {
        cwd: r.tempdir,
        envOverrides: { AC_ORIGINAL_CWD: process.cwd() },
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
  // root where outfits/ and modes/ live.
  const builtinDir = deps.builtinDir ?? findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const dirs = { projectDir, userDir, builtinDir };

  const env: NodeJS.ProcessEnv = { ...process.env, AC_WRAPPED: '1', AC_HARNESS: target };

  // Stage 2: load outfit/mode and persist a resolution artifact when filter is requested.
  const filtered = !args.noFilter && (args.outfit !== undefined || args.mode !== undefined);
  let outfit: OutfitManifest | undefined;
  let modeManifest: ModeManifest | undefined;
  let modeBody: string | undefined;
  let resolutionArtifactPath: string | undefined;
  if (filtered) {
    if (args.outfit) outfit = (await findOutfit(args.outfit, dirs)).manifest;
    if (args.mode) {
      const found = await findMode(args.mode, dirs);
      modeManifest = found?.manifest;
      modeBody = found?.body;
    }
    const catalog = await (deps.loadCatalog ?? (async () => discoverComponents(builtinDir)))();
    const { artifactPath } = await resolveAndPersist({
      catalog,
      outfit,
      mode: modeManifest,
      modeBody,
      harness: target,
    });
    resolutionArtifactPath = artifactPath;
    env.AC_RESOLUTION_PATH = artifactPath;
  }

  // Stage 3: harness-specific prelaunch composition.
  const effects = await prelaunchForTarget({
    target,
    outfit,
    mode: modeManifest,
    modeBody,
    resolutionArtifactPath,
    realHome: deps.homeDir ?? os.homedir(),
    apmPackageDir: deps.homeDir ?? process.cwd(),
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
