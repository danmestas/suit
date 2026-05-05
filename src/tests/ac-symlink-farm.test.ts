import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { composeHarnessHome } from '../lib/ac/symlink-farm.ts';

async function makeFakeUserHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'real-home-'));
  await fs.mkdir(path.join(home, '.claude', 'skills', 'a'), { recursive: true });
  await fs.mkdir(path.join(home, '.claude', 'skills', 'b'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'skills', 'a', 'SKILL.md'), '---\nname: a\n---\n');
  await fs.writeFile(path.join(home, '.claude', 'skills', 'b', 'SKILL.md'), '---\nname: b\n---\n');
  await fs.writeFile(path.join(home, '.claude', '.credentials.json'), '{"oauth":"fake"}');
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), '{}');
  return home;
}

describe('composeHarnessHome', () => {
  it('mirrors home via symlinks, replaces skills/ with filtered subset', async () => {
    const realHome = await makeFakeUserHome();
    const result = await composeHarnessHome({
      target: 'claude-code',
      realHome,
      skillsKeep: ['a'], // keep a, drop b
    });

    // tempdir/.claude/.credentials.json should be a symlink to realHome's credentials
    const credLink = path.join(result.tempHome, '.claude', '.credentials.json');
    const credStat = await fs.lstat(credLink);
    expect(credStat.isSymbolicLink()).toBe(true);

    // tempdir/.claude/skills should contain only 'a'
    const skillsDir = path.join(result.tempHome, '.claude', 'skills');
    const filtered = await fs.readdir(skillsDir);
    expect(filtered).toContain('a');
    expect(filtered).not.toContain('b');
  });

  it('returns a cleanup function that removes the tempdir', async () => {
    const realHome = await makeFakeUserHome();
    const result = await composeHarnessHome({
      target: 'claude-code',
      realHome,
      skillsKeep: [],
    });
    await result.cleanup();
    await expect(fs.access(result.tempHome)).rejects.toThrow();
  });

  it('throws for targets without user-scope skills layout', async () => {
    const realHome = await fs.mkdtemp(path.join(os.tmpdir(), 'real-home-'));
    await expect(
      composeHarnessHome({ target: 'codex', realHome, skillsKeep: [] }),
    ).rejects.toThrow(/codex.*no user-scope/i);
  });

  it('symlinks home-root files matching the harness prefix', async () => {
    const realHome = await fs.mkdtemp(path.join(os.tmpdir(), 'real-home-'));
    await fs.mkdir(path.join(realHome, '.claude'), { recursive: true });
    await fs.writeFile(path.join(realHome, '.claude', '.credentials.json'), '{}');
    await fs.writeFile(path.join(realHome, '.claude.json'), '{"x":1}');
    await fs.writeFile(path.join(realHome, '.claude-extra.txt'), 'extra');
    await fs.writeFile(path.join(realHome, '.bashrc'), 'unrelated');

    const result = await composeHarnessHome({
      target: 'claude-code',
      realHome,
      skillsKeep: [],
    });

    // .claude.json should be symlinked at home root
    const stat = await fs.lstat(path.join(result.tempHome, '.claude.json'));
    expect(stat.isSymbolicLink()).toBe(true);
    // .claude-extra.txt should also be symlinked (matches prefix)
    expect((await fs.lstat(path.join(result.tempHome, '.claude-extra.txt'))).isSymbolicLink()).toBe(true);
    // .bashrc should NOT be symlinked
    await expect(fs.access(path.join(result.tempHome, '.bashrc'))).rejects.toThrow();
  });

  // ─── v0.7+ globals filtering ────────────────────────────────────────────

  async function makeFakeUserHomeWithPluginsAndConfig(): Promise<string> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'real-home-'));
    await fs.mkdir(path.join(home, '.claude', 'skills'), { recursive: true });
    // Real Claude Code plugins layout: cache/<marketplace>/<plugin>/<version>/
    // plus a flat installed_plugins.json manifest. Filtering rewrites the
    // manifest; the plugin code dirs (cache/, data/, etc.) stay intact.
    await fs.mkdir(path.join(home, '.claude', 'plugins', 'cache'), { recursive: true });
    await fs.mkdir(path.join(home, '.claude', 'plugins', 'data'), { recursive: true });
    await fs.mkdir(path.join(home, '.claude', 'plugins', 'marketplaces'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify(
        {
          version: 2,
          plugins: {
            'p1@market-a': [{ scope: 'user', version: '1.0.0' }],
            'p2@market-a': [{ scope: 'user', version: '1.0.0' }],
            'p3@market-b': [{ scope: 'user', version: '1.0.0' }],
          },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(path.join(home, '.claude', 'plugins', 'blocklist.json'), '{}');
    // .claude.json with mcpServers
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify(
        {
          oauthAccount: { id: 'fake' },
          mcpServers: {
            keep1: { command: 'k1' },
            drop1: { command: 'd1' },
            keep2: { command: 'k2' },
          },
        },
        null,
        2,
      ),
    );
    return home;
  }

  it('pluginsKeep rewrites installed_plugins.json filtered to listed names', async () => {
    const realHome = await makeFakeUserHomeWithPluginsAndConfig();
    const result = await composeHarnessHome({
      target: 'claude-code',
      realHome,
      skillsKeep: [],
      pluginsKeep: ['p1', 'p3'], // keep p1 and p3, drop p2
    });

    const pluginsDir = path.join(result.tempHome, '.claude', 'plugins');
    const stat = await fs.lstat(pluginsDir);
    // plugins dir should be a real directory, not a symlink — we own it now
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);

    // Plugin code dirs (cache/data/marketplaces) and other manifests are
    // symlinked through unchanged — Claude Code reads installed_plugins.json
    // to know what's loaded, so disabled plugins keep their files but aren't
    // referenced.
    expect((await fs.lstat(path.join(pluginsDir, 'cache'))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(pluginsDir, 'data'))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(pluginsDir, 'blocklist.json'))).isSymbolicLink()).toBe(true);

    // installed_plugins.json is a real file (rewritten copy), filtered.
    const manifestPath = path.join(pluginsDir, 'installed_plugins.json');
    expect((await fs.lstat(manifestPath)).isSymbolicLink()).toBe(false);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const keys = Object.keys(manifest.plugins).sort();
    expect(keys).toEqual(['p1@market-a', 'p3@market-b']);
    expect(manifest.plugins['p2@market-a']).toBeUndefined();
    expect(manifest.version).toBe(2); // top-level keys preserved
  });

  it('pluginsKeep=[] yields an empty installed_plugins.json (disable everything)', async () => {
    const realHome = await makeFakeUserHomeWithPluginsAndConfig();
    const result = await composeHarnessHome({
      target: 'claude-code',
      realHome,
      skillsKeep: [],
      pluginsKeep: [],
    });
    const manifestPath = path.join(result.tempHome, '.claude', 'plugins', 'installed_plugins.json');
    expect((await fs.lstat(manifestPath)).isSymbolicLink()).toBe(false);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    expect(manifest.plugins).toEqual({}); // every entry filtered out
  });

  it('pluginsKeep matches marketplace-disambiguated names too', async () => {
    const realHome = await makeFakeUserHomeWithPluginsAndConfig();
    // Use the disambiguated form `<bare>-<marketplace>` (the registry's
    // collision-resolution name) — should also match the manifest key.
    const result = await composeHarnessHome({
      target: 'claude-code',
      realHome,
      skillsKeep: [],
      pluginsKeep: ['p1-market-a', 'p3-market-b'],
    });
    const manifest = JSON.parse(
      await fs.readFile(path.join(result.tempHome, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'),
    );
    expect(Object.keys(manifest.plugins).sort()).toEqual(['p1@market-a', 'p3@market-b']);
  });

  it('pluginsKeep undefined falls back to symlinking the whole plugins/ dir', async () => {
    const realHome = await makeFakeUserHomeWithPluginsAndConfig();
    const result = await composeHarnessHome({
      target: 'claude-code',
      realHome,
      skillsKeep: [],
      // pluginsKeep omitted → v0.6 behavior: symlink the whole dir
    });
    const pluginsDir = path.join(result.tempHome, '.claude', 'plugins');
    const stat = await fs.lstat(pluginsDir);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('mcpsKeep rewrites .claude.json with filtered mcpServers (real file)', async () => {
    const realHome = await makeFakeUserHomeWithPluginsAndConfig();
    const result = await composeHarnessHome({
      target: 'claude-code',
      realHome,
      skillsKeep: [],
      mcpsKeep: ['keep1', 'keep2'],
    });

    const configPath = path.join(result.tempHome, '.claude.json');
    const stat = await fs.lstat(configPath);
    expect(stat.isSymbolicLink()).toBe(false); // must be a real file
    expect(stat.isFile()).toBe(true);

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(['keep1', 'keep2']);
    expect(parsed.mcpServers.drop1).toBeUndefined();
    // Other top-level keys preserved verbatim
    expect(parsed.oauthAccount).toEqual({ id: 'fake' });
  });

  it('mcpsKeep undefined falls back to symlinking .claude.json as-is', async () => {
    const realHome = await makeFakeUserHomeWithPluginsAndConfig();
    const result = await composeHarnessHome({
      target: 'claude-code',
      realHome,
      skillsKeep: [],
      // mcpsKeep omitted → symlink-everything path
    });
    const configPath = path.join(result.tempHome, '.claude.json');
    const stat = await fs.lstat(configPath);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('mcpsKeep on a config without mcpServers passes through', async () => {
    const realHome = await fs.mkdtemp(path.join(os.tmpdir(), 'real-home-'));
    await fs.mkdir(path.join(realHome, '.claude'), { recursive: true });
    await fs.writeFile(path.join(realHome, '.claude.json'), JSON.stringify({ oauthAccount: { id: 'x' } }));

    const result = await composeHarnessHome({
      target: 'claude-code',
      realHome,
      skillsKeep: [],
      mcpsKeep: ['keep1'],
    });

    const configPath = path.join(result.tempHome, '.claude.json');
    const stat = await fs.lstat(configPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(parsed.oauthAccount).toEqual({ id: 'x' });
    expect(parsed.mcpServers).toBeUndefined();
  });
});
