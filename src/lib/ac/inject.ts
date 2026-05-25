/**
 * `suit inject` — realtime component injection into a running worker's harness
 * home (the realtime counterpart to the project-state `suit up`).
 *
 * Increment 1 scope (this file): materialize a single accessory/bundle's files
 * into a target home dir, record them in the lockfile's `injected` list, with
 * `up`'s idempotency + refuse-when-dirty contract, and compute (but do not
 * fire) a reload decision per harness. NATS target discovery, the reload
 * signal, and `suit off` injection-cleanup are LATER increments.
 *
 * Architecture: this REUSES the `suit up` pipeline. composeBundle(outfit:null,
 * accessories:[name]) produces the same per-target PendingFile matrix `up`
 * gets; ProjectWriter writes them rooted at the inject target's home; the
 * lockfile's `injected` list records provenance distinct from `up`'s `files`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectWriter } from '../writer.js';
import {
  readLockfile,
  writeLockfile,
  sha256OfFile,
  type Lockfile,
  type LockEntry,
  type InjectedComponent,
} from '../lockfile.js';
import { composeBundle, type PendingFile } from './compose.js';
import type { Target, ComponentType } from '../types.js';

export interface RunInjectArgs {
  /** The accessory/bundle name to inject (`--accessory`/`--bundle`). */
  component: string;
  /** Target harness home dir — files are written here; lockfile at <home>/.suit/lock.json. */
  home: string;
  /** Wardrobe content dir (default = configured content dir; overridden by `--from`). */
  contentDir: string;
  /** User overlay dir for component overrides. */
  userDir: string;
  /** Resolve + report what would be materialized; write nothing. */
  dryRun: boolean;
  /** Skip the reload signal (this increment: report it as skipped). */
  noReload: boolean;
  /** Override refuse-when-dirty on untracked/edited target files. */
  force: boolean;
  /** Emit a machine-readable JSON result instead of human lines. */
  json: boolean;
}

export interface RunInjectDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export type ReloadDecision = 'not-required' | 'restart-required';

/**
 * Pure reload decision per the proposal's verified pickup table. On claude-code
 * the file-watcher covers standalone skills, hooks, agents, and rules — those
 * are live on the next turn (`not-required`). Plugin and MCP kinds need a
 * restart (`restart-required`). Other harnesses (codex/gemini/pi) are
 * conservatively `restart-required` for everything until their reload verbs are
 * verified in a later increment.
 *
 * `kinds` is the set of component types present in the materialized files; a
 * mixed set escalates to `restart-required` if ANY kind needs it.
 */
export function reloadDecision(harness: Target, kinds: Set<ComponentType>): ReloadDecision {
  if (harness !== 'claude-code') return 'restart-required';
  const fileWatched: ReadonlySet<ComponentType> = new Set<ComponentType>([
    'skill',
    'hook',
    'agent',
    'rules',
  ]);
  for (const k of kinds) {
    if (!fileWatched.has(k)) return 'restart-required';
  }
  return 'not-required';
}

/**
 * Classify a pending file's component kind from its `sourceComponent` (which is
 * the component's `relativeDir`, e.g. "skills/foo", "hooks/bar", "mcps/baz").
 * Used to derive the reload-decision kind set. Unknown prefixes map to undefined
 * and are ignored by the caller (e.g. the synthesized CLAUDE.md outfit block,
 * which never appears on an inject).
 */
function kindFromSourceComponent(source: string): ComponentType | undefined {
  const top = source.split('/')[0];
  switch (top) {
    case 'skills':
      return 'skill';
    case 'hooks':
      return 'hook';
    case 'agents':
      return 'agent';
    case 'rules':
      return 'rules';
    case 'mcps':
      return 'mcp';
    case 'plugins':
      return 'plugin';
    default:
      return undefined;
  }
}

/** Build a path → sha256 map of everything the lockfile already tracks (up files + injected). */
function trackedByPath(lock: Lockfile | null): Map<string, string> {
  const m = new Map<string, string>();
  if (!lock) return m;
  for (const f of lock.files) m.set(f.path, f.sha256);
  for (const inj of lock.injected ?? []) {
    for (const f of inj.files) m.set(f.path, f.sha256);
  }
  return m;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function runInject(args: RunInjectArgs, deps: RunInjectDeps): Promise<number> {
  // Compose the accessory's files with no base outfit — composeBundle handles
  // the outfit-less path; resolution.ts resolves the accessory's include block.
  // Errors (component-not-found, strict-include) propagate to the top-level CLI
  // catch, mirroring `suit up`.
  const composed = await composeBundle(
    {
      outfit: null,
      cut: null,
      accessories: [args.component],
      projectDir: args.home,
      contentDir: args.contentDir,
      userDir: args.userDir,
    },
    { stderr: deps.stderr },
  );
  const { pending, targets } = composed;

  // Reload decision: derive the kind set from the materialized files' sources.
  const kinds = new Set<ComponentType>();
  for (const f of pending) {
    const k = kindFromSourceComponent(f.sourceComponent);
    if (k) kinds.add(k);
  }
  // The decision is per-harness; with multiple targets, escalate to
  // restart-required if any harness needs it.
  let decision: ReloadDecision = 'not-required';
  for (const t of targets) {
    if (reloadDecision(t, kinds) === 'restart-required') {
      decision = 'restart-required';
      break;
    }
  }
  const reloadReport: string = args.noReload
    ? 'skipped (--no-reload)'
    : decision;

  const priorLock = await readLockfile(args.home);
  const tracked = trackedByPath(priorLock);

  // Idempotency: if every pending file already exists at the target with a
  // matching sha256 (tracked OR on disk), this is a no-op.
  let allUnchanged = pending.length > 0;
  for (const f of pending) {
    if (f.lockMode === 'additive') {
      // Additive files share their host file with user content; a whole-file
      // sha won't match, so they can't satisfy the unchanged check. (Inject of
      // a pure accessory rarely emits additive content, but be safe.)
      allUnchanged = false;
      break;
    }
    const full = path.join(args.home, f.path);
    if (!(await fileExists(full))) {
      allUnchanged = false;
      break;
    }
    const currentSha = await sha256OfFile(full);
    const trackedSha = tracked.get(f.path);
    if (currentSha !== f.sha256 || (trackedSha !== undefined && trackedSha !== f.sha256)) {
      allUnchanged = false;
      break;
    }
  }

  if (allUnchanged) {
    report(args, deps, {
      status: 'unchanged',
      component: args.component,
      home: args.home,
      files: pending.length,
      reload: reloadReport,
      targets,
    });
    return 0;
  }

  // Refuse-when-dirty: a target that exists but is neither tracked nor
  // sha-matching → refuse unless --force. Additive paths skip the whole-file
  // check (same as up.ts).
  if (!args.force) {
    for (const f of pending) {
      if (f.lockMode === 'additive') continue;
      const full = path.join(args.home, f.path);
      if (!(await fileExists(full))) continue;
      const currentSha = await sha256OfFile(full);
      const trackedSha = tracked.get(f.path);
      if (trackedSha === undefined && currentSha !== f.sha256) {
        deps.stderr(
          `suit inject: target exists and is not suit-managed: ${f.path} (pass --force to overwrite)\n`,
        );
        return 1;
      }
      if (trackedSha !== undefined && currentSha !== trackedSha) {
        deps.stderr(
          `suit inject: target hand-edited since suit applied it: ${f.path} (pass --force to overwrite)\n`,
        );
        return 1;
      }
    }
  }

  if (args.dryRun) {
    report(args, deps, {
      status: 'dry-run',
      component: args.component,
      home: args.home,
      files: pending.length,
      reload: reloadReport,
      targets,
    });
    return 0;
  }

  // Materialize.
  const writer = new ProjectWriter(args.home);
  for (const f of pending) {
    await writer.write({ path: f.path, content: f.content, mode: f.mode });
  }

  // Record into the lockfile's injected list (replace any prior entry for the
  // same component name; preserve up's files/resolution untouched). Create a
  // minimal lockfile if none exists.
  const injectedFiles: LockEntry[] = pending
    .map((f) => {
      const entry: LockEntry = { path: f.path, sha256: f.sha256, sourceComponent: f.sourceComponent };
      if (f.lockMode && f.lockMode !== 'replace') entry.mode = f.lockMode;
      return entry;
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const now = new Date().toISOString();
  const newEntry: InjectedComponent = {
    component: args.component,
    injectedAt: now,
    files: injectedFiles,
  };

  let lock: Lockfile;
  if (priorLock) {
    const injected = (priorLock.injected ?? []).filter((e) => e.component !== args.component);
    injected.push(newEntry);
    lock = { ...priorLock, injected };
  } else {
    lock = {
      schemaVersion: 1,
      appliedAt: now,
      resolution: { outfit: null, cut: null, accessories: [] },
      files: [],
      injected: [newEntry],
    };
  }
  await writeLockfile(args.home, lock);

  report(args, deps, {
    status: 'injected',
    component: args.component,
    home: args.home,
    files: pending.length,
    reload: reloadReport,
    targets,
  });
  return 0;
}

interface InjectReport {
  status: 'injected' | 'unchanged' | 'dry-run';
  component: string;
  home: string;
  files: number;
  reload: string;
  targets: Target[];
}

function report(args: RunInjectArgs, deps: RunInjectDeps, r: InjectReport): void {
  if (args.json) {
    deps.stdout(
      JSON.stringify({
        status: r.status,
        component: r.component,
        home: r.home,
        files: r.files,
        reload: r.reload,
        targets: r.targets,
      }) + '\n',
    );
    return;
  }
  deps.stdout(`${r.status}: ${r.component} (${r.files} file${r.files === 1 ? '' : 's'})\n`);
  deps.stdout(`  home:    ${r.home}\n`);
  deps.stdout(`  targets: [${r.targets.join(', ')}]\n`);
  deps.stdout(`  reload:  ${r.reload}\n`);
}
