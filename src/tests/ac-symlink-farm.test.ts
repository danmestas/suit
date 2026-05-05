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
    // Plugins
    await fs.mkdir(path.join(home, '.claude', 'plugins', 'p1'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude', 'plugins', 'p1', 'plugin.json'), '{}');
    await fs.mkdir(path.join(home, '.claude', 'plugins', 'p2'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude', 'plugins', 'p2', 'plugin.json'), '{}');
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

  it('pluginsKeep filters subdirs to only listed names', async () => {
    const realHome = await makeFakeUserHomeWithPluginsAndConfig();
    const result = await composeHarnessHome({
      target: 'claude-code',
      realHome,
      skillsKeep: [],
      pluginsKeep: ['p1'], // keep p1, drop p2
    });

    const pluginsDir = path.join(result.tempHome, '.claude', 'plugins');
    const stat = await fs.lstat(pluginsDir);
    // plugins dir should be a real directory, not a symlink — we own it now
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);

    const entries = await fs.readdir(pluginsDir);
    expect(entries).toContain('p1');
    expect(entries).not.toContain('p2');
  });

  it('pluginsKeep=[] yields an empty plugins/ dir (disable everything)', async () => {
    const realHome = await makeFakeUserHomeWithPluginsAndConfig();
    const result = await composeHarnessHome({
      target: 'claude-code',
      realHome,
      skillsKeep: [],
      pluginsKeep: [],
    });
    const pluginsDir = path.join(result.tempHome, '.claude', 'plugins');
    const stat = await fs.stat(pluginsDir);
    expect(stat.isDirectory()).toBe(true);
    const entries = await fs.readdir(pluginsDir);
    expect(entries).toEqual([]);
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
