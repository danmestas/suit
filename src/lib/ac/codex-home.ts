import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';

export interface ComposeCodexHomeOptions {
  realCodexHome: string;
  /** Skill names to KEEP (symlinked into tempdir/skills/). Others are dropped. */
  skillsKeep: string[];
  /**
   * Kept-set of plugin bare names. When provided (even empty), every
   * `[plugins."<bare>@<marketplace>"]` block in `config.toml` whose bare name
   * is NOT in this list has its `enabled` field set to `false`. Kept entries
   * are left alone — we don't force-enable a plugin the user had disabled for
   * an unrelated reason. Undefined = no plugin filtering (config.toml is
   * symlinked through unmodified).
   */
  pluginsKeep?: string[];
  /**
   * Kept-set of MCP server names. When provided, every `[mcp_servers.<id>]`
   * block whose id is NOT in this list gets `enabled = false`. Same
   * don't-force semantics as pluginsKeep. Undefined = no filtering.
   */
  mcpsKeep?: string[];
}

export interface ComposeCodexHomeResult {
  /** Tempdir to set as `CODEX_HOME` when spawning codex. */
  tempCodexHome: string;
  cleanup: () => Promise<void>;
}

const SKILLS_SUB = 'skills';
const CONFIG_FILE = 'config.toml';

/**
 * Build a tempdir mirroring the user's real `$CODEX_HOME` (typically
 * `~/.codex/`) suitable for use as `CODEX_HOME` when launching codex with a
 * filtered set of plugins, MCP servers, and skills.
 *
 * Mechanism:
 *   - Every entry in the real codex home is symlinked into the tempdir EXCEPT
 *     `skills/` (rebuilt as a curated subset) and `config.toml` when filtering
 *     is requested.
 *   - When `pluginsKeep` and/or `mcpsKeep` is provided, the real `config.toml`
 *     is parsed, mutated (`enabled = false` on non-kept entries), and written
 *     to the tempdir as a real file. All other top-level TOML keys (model,
 *     marketplaces, projects, features, …) are preserved verbatim.
 *
 * Cleanup removes the tempdir tree on session end. Symlinks point at the real
 * codex home, so removing the tempdir cannot affect the user's actual config.
 */
export async function composeCodexHome(
  opts: ComposeCodexHomeOptions,
): Promise<ComposeCodexHomeResult> {
  const tempCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-codex-home-'));

  const realEntries = await readdirSafe(opts.realCodexHome);

  const filterConfig = opts.pluginsKeep !== undefined || opts.mcpsKeep !== undefined;

  for (const entry of realEntries) {
    if (entry === SKILLS_SUB) continue; // rebuilt below
    if (filterConfig && entry === CONFIG_FILE) continue; // rewritten below
    const src = path.join(opts.realCodexHome, entry);
    const dest = path.join(tempCodexHome, entry);
    try {
      await fs.symlink(src, dest);
    } catch {
      // best-effort
    }
  }

  // Rewrite config.toml when filtering is in play.
  if (filterConfig) {
    await rewriteConfigToml(opts, tempCodexHome);
  }

  // Build curated skills/ subdir.
  const tempSkillsDir = path.join(tempCodexHome, SKILLS_SUB);
  await fs.mkdir(tempSkillsDir, { recursive: true });
  const realSkillsDir = path.join(opts.realCodexHome, SKILLS_SUB);
  for (const skillName of opts.skillsKeep) {
    const src = path.join(realSkillsDir, skillName);
    const dest = path.join(tempSkillsDir, skillName);
    try {
      await fs.access(src);
      await fs.symlink(src, dest);
    } catch {
      // skip silently — skill in keep list isn't on disk
    }
  }

  return {
    tempCodexHome,
    cleanup: async () => {
      try {
        await fs.rm(tempCodexHome, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function rewriteConfigToml(
  opts: ComposeCodexHomeOptions,
  tempCodexHome: string,
): Promise<void> {
  const realConfig = path.join(opts.realCodexHome, CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(realConfig, 'utf8');
  } catch {
    // No config.toml exists at the real codex home. Nothing to rewrite — the
    // tempdir is left without a config.toml, which mirrors the source state.
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = TOML.parse(raw) as Record<string, unknown>;
  } catch {
    // Malformed config — symlink the real file through and let codex surface
    // the parse error. Same fallback as the claude-code path.
    try {
      await fs.symlink(realConfig, path.join(tempCodexHome, CONFIG_FILE));
    } catch {
      // best-effort
    }
    return;
  }

  if (opts.pluginsKeep !== undefined) {
    const keep = new Set(opts.pluginsKeep);
    const pluginsBlock = parsed.plugins;
    if (pluginsBlock && typeof pluginsBlock === 'object' && !Array.isArray(pluginsBlock)) {
      for (const [composite, val] of Object.entries(pluginsBlock as Record<string, unknown>)) {
        if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
        const at = composite.lastIndexOf('@');
        const bare = at > 0 ? composite.slice(0, at) : composite;
        const marketplace = at > 0 && at < composite.length - 1 ? composite.slice(at + 1) : '';
        const disambig = marketplace ? `${bare}-${marketplace}` : bare;
        const isKept = keep.has(bare) || keep.has(disambig);
        if (!isKept) {
          (val as Record<string, unknown>).enabled = false;
        }
        // We never force `enabled = true`. If the user disabled a plugin out
        // of band, the kept-set doesn't second-guess that.
      }
    }
  }

  if (opts.mcpsKeep !== undefined) {
    const keep = new Set(opts.mcpsKeep);
    const mcpsBlock = parsed.mcp_servers;
    if (mcpsBlock && typeof mcpsBlock === 'object' && !Array.isArray(mcpsBlock)) {
      for (const [id, val] of Object.entries(mcpsBlock as Record<string, unknown>)) {
        if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
        if (!keep.has(id)) {
          (val as Record<string, unknown>).enabled = false;
        }
      }
    }
  }

  // @iarna/toml expects a JsonMap; Record<string, unknown> is structurally
  // compatible at runtime. Cast through unknown to satisfy the typings.
  const out = TOML.stringify(parsed as unknown as TOML.JsonMap);
  await fs.writeFile(path.join(tempCodexHome, CONFIG_FILE), out);
}
