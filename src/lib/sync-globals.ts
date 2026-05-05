import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import YAML from 'yaml';
import {
  GlobalsRegistrySchema,
  type GlobalsRegistry,
  type GlobalsPluginEntry,
  type GlobalsMcpEntry,
} from './globals-schema.js';

export interface SyncGlobalsOptions {
  /** Override $HOME (used by tests). Defaults to os.homedir(). */
  home?: string;
  /** Override hostname (used by tests). Defaults to os.hostname(). */
  hostname?: string;
  /** Override timestamp (used by tests). Defaults to new Date().toISOString(). */
  now?: string;
}

/**
 * Read `<home>/.claude/plugins/installed_plugins.json` and `<home>/.claude.json`
 * to construct a GlobalsRegistry snapshot for the current machine.
 *
 * `discover_path` is emitted with a literal `~` for portability — the suit
 * resolver expands it at lookup time.
 */
export async function buildGlobalsSnapshot(
  opts: SyncGlobalsOptions = {},
): Promise<GlobalsRegistry> {
  const home = opts.home ?? os.homedir();
  const hostname = opts.hostname ?? os.hostname();
  const generatedAt = opts.now ?? new Date().toISOString();

  const plugins = await discoverPlugins(home);
  const mcps = await discoverMcps(home);

  const snapshot: GlobalsRegistry = {
    schemaVersion: 1,
    generated_at: generatedAt,
    machine: hostname,
    plugins,
    mcps,
    hooks: {},
  };

  // Round-trip through the schema to enforce shape invariants.
  return GlobalsRegistrySchema.parse(snapshot);
}

interface InstalledPluginEntry {
  scope?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
}

interface InstalledPluginsFile {
  version?: number;
  plugins?: Record<string, InstalledPluginEntry[]>;
}

async function discoverPlugins(
  home: string,
): Promise<Record<string, GlobalsPluginEntry>> {
  // The authoritative source for user-scope plugins is
  // `~/.claude/plugins/installed_plugins.json`. The sibling subdirs
  // (`cache/`, `data/`, `repos/`, `marketplaces/`) are internal Claude Code
  // bookkeeping and must NOT be treated as plugins.
  const installedPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  const out: Record<string, GlobalsPluginEntry> = {};
  let parsed: InstalledPluginsFile | null = null;
  try {
    const raw = await fs.readFile(installedPath, 'utf8');
    parsed = JSON.parse(raw) as InstalledPluginsFile;
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.plugins) return out;

  // Phase 1: pick the user-scope entry per `<plugin>@<marketplace>` key. If
  // multiple user-scope entries exist (rare; manifest bug), keep the most
  // recently updated.
  type Pick = {
    pluginName: string;
    marketplace: string;
    entry: InstalledPluginEntry;
  };
  const picks: Pick[] = [];
  for (const [composite, rawEntries] of Object.entries(parsed.plugins)) {
    if (!Array.isArray(rawEntries)) continue;
    const at = composite.lastIndexOf('@');
    if (at <= 0 || at === composite.length - 1) continue; // malformed key
    const pluginName = composite.slice(0, at);
    const marketplace = composite.slice(at + 1);
    const userEntries = rawEntries.filter(
      (e) => e && typeof e === 'object' && e.scope === 'user',
    );
    if (userEntries.length === 0) continue; // project-scope only — skip
    userEntries.sort((a, b) => {
      const ta = a.lastUpdated ?? '';
      const tb = b.lastUpdated ?? '';
      return tb.localeCompare(ta);
    });
    picks.push({ pluginName, marketplace, entry: userEntries[0]! });
  }

  // Phase 2: detect bare-name collisions across marketplaces. Disambiguate by
  // appending `-<marketplace>` when a name appears more than once.
  const bareCounts = new Map<string, number>();
  for (const pick of picks) {
    bareCounts.set(pick.pluginName, (bareCounts.get(pick.pluginName) ?? 0) + 1);
  }

  for (const pick of picks) {
    const collides = (bareCounts.get(pick.pluginName) ?? 0) > 1;
    const registryName = collides
      ? `${pick.pluginName}-${pick.marketplace}`
      : pick.pluginName;
    if (!isKebab(registryName)) {
      // Schema rejects non-kebab keys. Skip silently — the underlying plugin
      // is likely named in a way that doesn't fit the registry contract.
      continue;
    }
    const source: GlobalsPluginEntry['source'] =
      pick.marketplace === 'claude-plugins-official'
        ? 'claude-code-marketplace'
        : 'manual';
    const version = sanitizeVersion(pick.entry.version);
    const discover = installPathToDiscoverPath(pick.entry.installPath, home);
    const pluginEntry: GlobalsPluginEntry = {
      source,
      install: `claude plugin install ${pick.pluginName}`,
      discover_path: discover,
      ...(version ? { version } : {}),
    };
    out[registryName] = pluginEntry;
  }
  return out;
}

/**
 * Convert an absolute `installPath` from installed_plugins.json into a
 * tilde-prefixed, home-relative path. Falls back to a synthesized cache-style
 * path if the value is malformed/missing — preserves the schema's
 * "discover_path is a non-empty string" contract.
 */
function installPathToDiscoverPath(installPath: string | undefined, home: string): string {
  if (typeof installPath === 'string' && installPath.length > 0) {
    if (installPath.startsWith(home + path.sep)) {
      return `~${installPath.slice(home.length)}`;
    }
    if (installPath === home) return '~';
  }
  // Best-effort fallback so we still emit a valid (non-empty) path.
  return '~/.claude/plugins/cache/<unknown>';
}

function sanitizeVersion(v: string | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  if (/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(v)) return v;
  return undefined;
}

async function discoverMcps(
  home: string,
): Promise<Record<string, GlobalsMcpEntry>> {
  const claudeJsonPath = path.join(home, '.claude.json');
  const out: Record<string, GlobalsMcpEntry> = {};
  let parsed: unknown;
  try {
    const raw = await fs.readFile(claudeJsonPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  const servers = (parsed as Record<string, unknown>)['mcpServers'];
  if (!servers || typeof servers !== 'object') return out;
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!isKebab(name)) continue; // schema requires kebab-case keys
    if (!cfg || typeof cfg !== 'object') continue;
    const cfgObj = cfg as Record<string, unknown>;
    const discover = `~/.claude.json#mcpServers.${name}`;

    // HTTP transport: explicit `type: "http"` or a top-level `url` field.
    const isHttp =
      cfgObj.type === 'http' ||
      (typeof cfgObj.url === 'string' && cfgObj.url.length > 0);

    if (isHttp) {
      if (typeof cfgObj.url !== 'string' || cfgObj.url.length === 0) continue;
      const hasHeaders =
        typeof cfgObj.headers === 'object' &&
        cfgObj.headers !== null &&
        Object.keys(cfgObj.headers as Record<string, unknown>).length > 0;
      out[name] = {
        source: 'claude-code-config',
        type: 'http',
        url: cfgObj.url,
        has_headers: hasHeaders,
        discover_path: discover,
      };
      continue;
    }

    // stdio transport: requires a command string.
    if (typeof cfgObj.command !== 'string') continue;
    // Record non-secret metadata only. `env` values often contain tokens, so we
    // capture only a presence flag — the runtime config stays the source of truth.
    const args = Array.isArray(cfgObj.args)
      ? (cfgObj.args.filter((a) => typeof a === 'string') as string[])
      : undefined;
    const hasEnv =
      typeof cfgObj.env === 'object' &&
      cfgObj.env !== null &&
      Object.keys(cfgObj.env as Record<string, unknown>).length > 0;
    out[name] = {
      source: 'claude-code-config',
      type: 'stdio',
      command: cfgObj.command,
      ...(args && args.length > 0 ? { args } : {}),
      has_env: hasEnv,
      discover_path: discover,
    };
  }
  return out;
}

function isKebab(s: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
}

export function renderGlobalsYaml(snapshot: GlobalsRegistry): string {
  // Deterministic, human-readable output.
  return YAML.stringify(snapshot, {
    indent: 2,
    lineWidth: 0,
    sortMapEntries: false,
  });
}

export interface OpenPrOptions {
  cwd: string;
  outFile: string;
  machine: string;
}

export interface OpenPrResult {
  branch: string;
  url?: string;
}

/**
 * Stage globals.yaml, commit, push to a date-stamped branch, and open a PR
 * via gh. Throws with a helpful message if gh is missing, the working tree
 * is dirty (other untracked changes), or git operations fail.
 */
export function openPr(opts: OpenPrOptions): OpenPrResult {
  // Ensure cwd is a git repo.
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: opts.cwd,
      stdio: 'ignore',
    });
  } catch {
    throw new Error(`--pr requires a git repository (cwd: ${opts.cwd})`);
  }
  // Ensure gh is available.
  try {
    execSync('gh --version', { stdio: 'ignore' });
  } catch {
    throw new Error('--pr requires the GitHub CLI (`gh`) to be installed and on PATH');
  }
  // Ensure the working tree (other than the out file) is clean.
  const status = execSync('git status --porcelain', {
    cwd: opts.cwd,
    encoding: 'utf8',
  });
  const dirty = status
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => {
      const file = l.slice(3);
      const rel = path.relative(opts.cwd, path.resolve(opts.cwd, opts.outFile));
      return file !== rel && file !== opts.outFile;
    });
  if (dirty.length > 0) {
    throw new Error(
      `--pr requires a clean working tree (other than ${opts.outFile}); found:\n${dirty.join('\n')}`,
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  // Sanitize machine for branch naming.
  const safeMachine = opts.machine.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase();
  const branch = `chore/sync-globals-${safeMachine}-${date}`;

  execSync(`git checkout -b ${branch}`, { cwd: opts.cwd, stdio: 'inherit' });
  execSync(`git add ${quote(opts.outFile)}`, { cwd: opts.cwd, stdio: 'inherit' });
  execSync(
    `git commit -m ${quote(`chore: sync globals from ${opts.machine}`)}`,
    { cwd: opts.cwd, stdio: 'inherit' },
  );
  execSync(`git push -u origin ${branch}`, { cwd: opts.cwd, stdio: 'inherit' });
  const prUrl = execSync(
    `gh pr create --title ${quote(`chore: sync globals from ${opts.machine}`)} --body ${quote(`Automated globals snapshot from ${opts.machine}.`)}`,
    { cwd: opts.cwd, encoding: 'utf8' },
  ).trim();
  return { branch, url: prUrl || undefined };
}

function quote(s: string): string {
  // Single-quote for shell safety; escape embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
