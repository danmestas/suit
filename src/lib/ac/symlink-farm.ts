import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Target } from '../types.js';

export interface ComposeOptions {
  target: Target;
  realHome: string;
  /** Skill names to KEEP (symlinked into tempdir/.<harness>/skills/). Others are dropped. */
  skillsKeep: string[];
  /**
   * v0.7+: kept-set of user-scope plugin subdir names. When provided (even
   * empty array), the harness's `plugins/` dir is rebuilt as a real directory
   * with only the listed subdirs symlinked through. Undefined = symlink the
   * entire `plugins/` dir verbatim (current pre-v0.7 behavior).
   *
   * Only honored for `target === 'claude-code'` since plugins are a
   * Claude-Code-specific concept; other harnesses ignore this field.
   */
  pluginsKeep?: string[];
  /**
   * v0.7+: kept-set of MCP server names. When provided, `~/.claude.json` is
   * rewritten as a real file with `mcpServers` filtered to the listed names
   * (other top-level keys preserved). Undefined = symlink `~/.claude.json` as
   * before. Only honored for `target === 'claude-code'`.
   */
  mcpsKeep?: string[];
}

export interface ComposeResult {
  tempHome: string;
  cleanup: () => Promise<void>;
}

const TARGET_SUBDIRS: Record<Target, string | null> = {
  'claude-code': '.claude',
  gemini: '.gemini',
  pi: '.pi',
  apm: null,
  codex: null,
  copilot: null,
};

const TARGET_SKILLS_SUBDIR: Record<Target, string | null> = {
  'claude-code': 'skills',
  gemini: 'skills',
  pi: 'skills',
  apm: null,
  codex: null,
  copilot: null,
};

export async function composeHarnessHome(opts: ComposeOptions): Promise<ComposeResult> {
  const subdir = TARGET_SUBDIRS[opts.target];
  const skillsSub = TARGET_SKILLS_SUBDIR[opts.target];
  if (!subdir || !skillsSub) {
    throw new Error(`composeHarnessHome: target ${opts.target} has no user-scope skills layout`);
  }

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-home-'));
  const tempHarnessDir = path.join(tempHome, subdir);
  await fs.mkdir(tempHarnessDir, { recursive: true });

  const realHarnessDir = path.join(opts.realHome, subdir);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(realHarnessDir);
  } catch {
    // Real harness dir doesn't exist — leave tempdir mostly empty
  }

  // Plugin filtering only applies to claude-code (other harnesses don't have a
  // user-scope plugins concept in this code path). For other targets, the
  // `plugins` subdir (if any) gets symlinked through with everything else.
  const filterPlugins = opts.target === 'claude-code' && opts.pluginsKeep !== undefined;
  const PLUGINS_SUB = 'plugins';

  // Symlink every entry except skills/ (and plugins/ when filtered).
  for (const entry of entries) {
    if (entry === skillsSub) continue;
    if (filterPlugins && entry === PLUGINS_SUB) continue;
    const src = path.join(realHarnessDir, entry);
    const dest = path.join(tempHarnessDir, entry);
    await fs.symlink(src, dest);
  }

  // Build filtered plugins/ dir when pluginsKeep is provided. Always create
  // the directory (even when the kept-set is empty) so Claude Code sees an
  // explicit empty plugins dir rather than nothing — that's the "disable
  // everything" intent.
  if (filterPlugins) {
    const tempPluginsDir = path.join(tempHarnessDir, PLUGINS_SUB);
    await fs.mkdir(tempPluginsDir, { recursive: true });
    const realPluginsDir = path.join(realHarnessDir, PLUGINS_SUB);
    for (const pluginName of opts.pluginsKeep ?? []) {
      const src = path.join(realPluginsDir, pluginName);
      const dest = path.join(tempPluginsDir, pluginName);
      try {
        await fs.access(src);
        await fs.symlink(src, dest);
      } catch {
        // Plugin in keep list isn't installed in user's home — skip silently;
        // the resolver's `unresolved` metadata is the surface for that.
      }
    }
  }

  // Home-root files matching the harness prefix (e.g. .claude.json) — needed
  // for auth and global config. mcpsKeep, when set, replaces the .claude.json
  // symlink with a real filtered file.
  const harnessPrefix = subdir; // e.g. '.claude'
  const filterMcps = opts.target === 'claude-code' && opts.mcpsKeep !== undefined;
  const CLAUDE_CONFIG = '.claude.json';
  let homeEntries: string[] = [];
  try {
    homeEntries = await fs.readdir(opts.realHome);
  } catch {
    // realHome unreadable — skip
  }
  for (const entry of homeEntries) {
    if (entry === harnessPrefix) continue; // already handled above
    if (!entry.startsWith(harnessPrefix)) continue;
    if (filterMcps && entry === CLAUDE_CONFIG) continue; // handled below
    const src = path.join(opts.realHome, entry);
    const dest = path.join(tempHome, entry);
    try {
      await fs.symlink(src, dest);
    } catch {
      // symlink may already exist (race) or src missing — best-effort
    }
  }

  // Rewrite ~/.claude.json with a filtered mcpServers block when mcpsKeep is
  // provided. Other top-level keys are preserved verbatim.
  if (filterMcps) {
    const realConfigPath = path.join(opts.realHome, CLAUDE_CONFIG);
    let raw: string | null = null;
    try {
      raw = await fs.readFile(realConfigPath, 'utf8');
    } catch {
      // No config file → nothing to rewrite. Skip (matches pre-v0.7 behavior
      // where the symlink would have been silently dropped on missing source).
    }
    if (raw !== null) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Malformed JSON — fall back to symlinking the file as-is rather than
        // crashing. The harness will surface the parse error itself.
        const dest = path.join(tempHome, CLAUDE_CONFIG);
        try {
          await fs.symlink(realConfigPath, dest);
        } catch { /* best-effort */ }
        parsed = null as unknown as Record<string, unknown>;
      }
      if (parsed !== null) {
        const keepSet = new Set(opts.mcpsKeep ?? []);
        const existing = (parsed as { mcpServers?: Record<string, unknown> }).mcpServers;
        if (existing && typeof existing === 'object') {
          const filtered: Record<string, unknown> = {};
          for (const [name, conf] of Object.entries(existing)) {
            if (keepSet.has(name)) filtered[name] = conf;
          }
          (parsed as { mcpServers: Record<string, unknown> }).mcpServers = filtered;
        }
        // If `mcpServers` was absent the file passes through unchanged.
        const dest = path.join(tempHome, CLAUDE_CONFIG);
        await fs.writeFile(dest, JSON.stringify(parsed, null, 2));
      }
    }
  }

  // Build filtered skills/ dir as a curated symlink subset
  const tempSkillsDir = path.join(tempHarnessDir, skillsSub);
  await fs.mkdir(tempSkillsDir);
  const realSkillsDir = path.join(realHarnessDir, skillsSub);
  for (const skillName of opts.skillsKeep) {
    const src = path.join(realSkillsDir, skillName);
    const dest = path.join(tempSkillsDir, skillName);
    try {
      await fs.access(src);
      await fs.symlink(src, dest);
    } catch {
      // Skill in keep list doesn't exist in user's home — skip silently
    }
  }

  return {
    tempHome,
    cleanup: async () => {
      try {
        await fs.rm(tempHome, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
