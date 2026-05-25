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
import { findAccessory } from '../accessory.js';
import { discoverComponents } from '../discover.js';
import type { Target, ComponentType, ComponentSource } from '../types.js';

/**
 * Which kind of inject this is. `accessory`/`bundle` inject an accessory's whole
 * declared include block; `skill`/`hook` inject a single bare component.
 */
export type InjectKind = 'accessory' | 'bundle' | 'skill' | 'hook';

export interface RunInjectArgs {
  /** The component name to inject (accessory/bundle name, or a skill/hook name). */
  component: string;
  /**
   * Which CLI flag supplied `component`. Drives the keep-set computation and the
   * lockfile provenance label (accessory/bundle keep the bare name; skill/hook
   * use a qualified `skill:<name>` / `hook:<name>` label so `suit current`/`off`
   * know what kind was injected).
   */
  kind: InjectKind;
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

/**
 * Order-insensitive equality of two lock-entry arrays by (path, sha256, mode).
 * Both inputs are expected pre-sorted by path, but we compare by path-keyed
 * lookup so a caller passing an unsorted array still gets a correct answer.
 * `sourceComponent` is informational and intentionally excluded — a re-inject
 * that produces the same bytes at the same paths is "unchanged" regardless of
 * any provenance-label cosmetics.
 */
function sameLockEntries(a: LockEntry[], b: LockEntry[]): boolean {
  if (a.length !== b.length) return false;
  const byPath = new Map<string, LockEntry>();
  for (const e of a) byPath.set(e.path, e);
  for (const e of b) {
    const prior = byPath.get(e.path);
    if (!prior) return false;
    if (prior.sha256 !== e.sha256) return false;
    if ((prior.mode ?? 'replace') !== (e.mode ?? 'replace')) return false;
  }
  return true;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** A component's keep-set key (`<type>:<name>`). */
function keepKey(type: ComponentType, name: string): string {
  return `${type}:${name}`;
}

/**
 * Map an accessory `include`-block field to the ComponentType used as the
 * keep-set key prefix. Note `include.rules` keys on the plural `rules` (the enum
 * value), and `include.commands` keys on `command` (no catalog entry today, so
 * it simply never matches — harmless).
 */
const INCLUDE_FIELD_TO_TYPE: Record<string, ComponentType | 'command'> = {
  skills: 'skill',
  rules: 'rules',
  hooks: 'hook',
  agents: 'agent',
  commands: 'command',
};

export interface KeepSetResult {
  /** `<type>:<name>` keys passed to composeBundle.restrictTo. */
  restrictTo: Set<string>;
  /** For accessory/bundle: the accessory name to pass to composeBundle.accessories. */
  accessories: string[];
  /**
   * Targets to emit for. For a bare skill/hook (empty `accessories`) composeBundle
   * cannot derive targets from any manifest union, so we supply them from the
   * component's own `targets:`. For an accessory this is empty — composeBundle
   * derives targets from the accessory manifest as usual.
   */
  targets: Target[];
  /** The lockfile provenance label (`suit current`/`off` read this). */
  lockLabel: string;
}

/**
 * Resolve a bare skill/hook from the discovered catalog, asserting it exists and
 * is the right type. Errors carry a clear message for the exit-1 not-found path.
 */
function resolveBareComponent(
  catalog: ComponentSource[],
  kind: 'skill' | 'hook',
  name: string,
): ComponentSource {
  const hit = catalog.find((c) => c.manifest.type === kind && c.manifest.name === name);
  if (!hit) {
    throw new Error(`suit inject: ${kind} "${name}" not found in wardrobe`);
  }
  return hit;
}

/**
 * Compute the explicit emission keep-set for an inject. For accessory/bundle the
 * keep-set is the accessory's declared `include` block (each field mapped to its
 * ComponentType prefix) plus its `skill_include` names. For a bare skill/hook the
 * keep-set is the single `<type>:<name>` key.
 *
 * Every named component is validated against the discovered catalog; an unknown
 * name throws (the caller maps that to exit 1). The accessory itself contributes
 * ONLY its declared components — never the whole catalog.
 */
export async function computeKeepSet(
  kind: InjectKind,
  component: string,
  catalog: ComponentSource[],
  dirs: { projectDir: string; userDir: string; builtinDir: string },
): Promise<KeepSetResult> {
  if (kind === 'skill' || kind === 'hook') {
    const hit = resolveBareComponent(catalog, kind, component);
    return {
      restrictTo: new Set([keepKey(kind, component)]),
      accessories: [],
      targets: hit.manifest.targets,
      lockLabel: `${kind}:${component}`,
    };
  }

  // accessory / bundle: read the accessory manifest and build the keep-set from
  // its include block + skill_include. findAccessory also handles the
  // accessory-as-role fall-through (a bare skill/hook/etc. named via --accessory).
  const found = await findAccessory(component, dirs);
  const m = found.manifest;
  const restrictTo = new Set<string>();

  // Accessory keep-set = its declared `include` block. (Unlike outfits/cuts/fits,
  // the accessory schema has no `skill_include` — `skills:` inside `include` is
  // the canonical accessory mechanism, so there's nothing extra to union here.)
  const include = (m.include ?? {}) as Record<string, string[] | undefined>;
  for (const [field, type] of Object.entries(INCLUDE_FIELD_TO_TYPE)) {
    for (const name of include[field] ?? []) {
      restrictTo.add(`${type}:${name}`);
    }
  }

  // Validate every named component exists in the catalog. `command:` keys are
  // exempt — the catalog doesn't walk commands/ yet, so they cannot be matched
  // and would spuriously fail an existence check.
  for (const key of restrictTo) {
    const sep = key.indexOf(':');
    const type = key.slice(0, sep) as ComponentType | 'command';
    const name = key.slice(sep + 1);
    if (type === 'command') continue;
    const exists = catalog.some((c) => c.manifest.type === type && c.manifest.name === name);
    if (!exists) {
      throw new Error(
        `suit inject: ${type} "${name}" (declared by accessory "${component}") not found in wardrobe`,
      );
    }
  }

  return { restrictTo, accessories: [component], targets: [], lockLabel: component };
}

export async function runInject(args: RunInjectArgs, deps: RunInjectDeps): Promise<number> {
  // Compute the explicit emission keep-set: inject scopes output to exactly the
  // declared components (an accessory's include block, or a single bare
  // skill/hook), NOT the whole wardrobe. This is the mechanism that both fixes
  // the over-emission bug and powers --skill/--hook. A not-found component
  // throws here → caught below → exit 1.
  const catalog = await discoverComponents(args.contentDir);
  let keepSet: KeepSetResult;
  try {
    keepSet = await computeKeepSet(args.kind, args.component, catalog, {
      projectDir: args.home,
      userDir: args.userDir,
      builtinDir: args.contentDir,
    });
  } catch (err) {
    deps.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const lockLabel = keepSet.lockLabel;

  // Compose with no base outfit and the explicit keep-set threaded through to
  // emitForTarget. All of composeBundle's post-processing (dedupe, additive
  // marker-wrap, path redirects) stays intact — off-cleanup + idempotency depend
  // on additive entries being marker-wrapped with stable block-shas.
  const composed = await composeBundle(
    {
      outfit: null,
      cut: null,
      accessories: keepSet.accessories,
      restrictTo: keepSet.restrictTo,
      targets: keepSet.targets,
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

  // Compute the lock-entries this inject would write. These are the source of
  // truth for idempotency: each carries the path + sha256 + optional additive
  // mode, where the additive sha is the marker-BLOCK hash (stable across
  // re-injects) — not the whole-file hash. Comparing this set against the prior
  // injected entry handles additive files correctly, which a whole-file on-disk
  // scan cannot (the host file mixes our block with user content).
  const injectedFiles: LockEntry[] = pending
    .map((f) => {
      const entry: LockEntry = { path: f.path, sha256: f.sha256, sourceComponent: f.sourceComponent };
      if (f.lockMode && f.lockMode !== 'replace') entry.mode = f.lockMode;
      return entry;
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  // Idempotency: if a prior injection of THIS component recorded the exact same
  // file set (same paths, shas, and modes — order-insensitive), this is a no-op.
  const priorEntry = (priorLock?.injected ?? []).find((e) => e.component === lockLabel);
  const allUnchanged = pending.length > 0 && priorEntry !== undefined && sameLockEntries(priorEntry.files, injectedFiles);

  if (allUnchanged) {
    report(args, deps, {
      status: 'unchanged',
      component: lockLabel,
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
      component: lockLabel,
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
  // minimal lockfile if none exists. `injectedFiles` was computed above for the
  // idempotency check and is reused here verbatim.
  const now = new Date().toISOString();
  const newEntry: InjectedComponent = {
    component: lockLabel,
    injectedAt: now,
    files: injectedFiles,
  };

  let lock: Lockfile;
  if (priorLock) {
    const injected = (priorLock.injected ?? []).filter((e) => e.component !== lockLabel);
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
    component: lockLabel,
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
