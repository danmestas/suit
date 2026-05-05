import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { composeCodexHome } from '../lib/ac/codex-home.ts';

async function makeFakeCodexHome(extraConfig?: string): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
  await fs.mkdir(path.join(home, 'skills', 'a'), { recursive: true });
  await fs.mkdir(path.join(home, 'skills', 'b'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'a', 'SKILL.md'), '---\nname: a\n---\n');
  await fs.writeFile(path.join(home, 'skills', 'b', 'SKILL.md'), '---\nname: b\n---\n');
  await fs.mkdir(path.join(home, 'plugins', 'cache'), { recursive: true });
  await fs.mkdir(path.join(home, 'hooks'), { recursive: true });
  await fs.writeFile(path.join(home, 'auth.json'), '{}');
  await fs.writeFile(
    path.join(home, 'config.toml'),
    extraConfig ??
      [
        'approval_policy = "never"',
        'model = "gpt-5.5"',
        '',
        '[features]',
        'external_migration = true',
        '',
        '[marketplaces.example]',
        'source_type = "git"',
        'source = "https://example.com/example.git"',
        '',
        '[plugins."p1@market-a"]',
        'enabled = true',
        '',
        '[plugins."p2@market-a"]',
        'enabled = true',
        '',
        '[plugins."p3@market-b"]',
        'enabled = false',
        '',
        '[mcp_servers.keep1]',
        'command = "k1"',
        '',
        '[mcp_servers.drop1]',
        'command = "d1"',
        '',
        '[mcp_servers.keep2]',
        'url = "https://example.com/mcp"',
        '',
      ].join('\n'),
  );
  return home;
}

describe('composeCodexHome', () => {
  it('mirrors codex home via symlinks for non-config entries', async () => {
    const real = await makeFakeCodexHome();
    const r = await composeCodexHome({ realCodexHome: real, skillsKeep: [] });
    // auth.json + plugins + hooks should be symlinks
    for (const entry of ['auth.json', 'plugins', 'hooks']) {
      const stat = await fs.lstat(path.join(r.tempCodexHome, entry));
      expect(stat.isSymbolicLink()).toBe(true);
    }
  });

  it('skills/ is rebuilt with only skillsKeep entries', async () => {
    const real = await makeFakeCodexHome();
    const r = await composeCodexHome({ realCodexHome: real, skillsKeep: ['a'] });
    const skillsDir = path.join(r.tempCodexHome, 'skills');
    const stat = await fs.lstat(skillsDir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    const filtered = await fs.readdir(skillsDir);
    expect(filtered).toContain('a');
    expect(filtered).not.toContain('b');
  });

  it('cleanup removes the tempdir', async () => {
    const real = await makeFakeCodexHome();
    const r = await composeCodexHome({ realCodexHome: real, skillsKeep: [] });
    await r.cleanup();
    await expect(fs.access(r.tempCodexHome)).rejects.toThrow();
  });

  it('without filters, config.toml is symlinked through', async () => {
    const real = await makeFakeCodexHome();
    const r = await composeCodexHome({ realCodexHome: real, skillsKeep: [] });
    const stat = await fs.lstat(path.join(r.tempCodexHome, 'config.toml'));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('pluginsKeep flips enabled=false on non-kept plugin blocks', async () => {
    const real = await makeFakeCodexHome();
    const r = await composeCodexHome({
      realCodexHome: real,
      skillsKeep: [],
      pluginsKeep: ['p1', 'p3'], // keep p1 and p3, drop p2
    });
    const cfgPath = path.join(r.tempCodexHome, 'config.toml');
    expect((await fs.lstat(cfgPath)).isSymbolicLink()).toBe(false);
    const parsed = TOML.parse(await fs.readFile(cfgPath, 'utf8')) as any;
    expect(parsed.plugins['p1@market-a'].enabled).toBe(true);
    expect(parsed.plugins['p2@market-a'].enabled).toBe(false); // disabled by filter
    expect(parsed.plugins['p3@market-b'].enabled).toBe(false); // user-disabled — left alone
  });

  it('pluginsKeep matches marketplace-disambiguated names', async () => {
    const real = await makeFakeCodexHome();
    const r = await composeCodexHome({
      realCodexHome: real,
      skillsKeep: [],
      pluginsKeep: ['p1-market-a'], // disambiguated form
    });
    const parsed = TOML.parse(
      await fs.readFile(path.join(r.tempCodexHome, 'config.toml'), 'utf8'),
    ) as any;
    expect(parsed.plugins['p1@market-a'].enabled).toBe(true);
    expect(parsed.plugins['p2@market-a'].enabled).toBe(false);
  });

  it('pluginsKeep matches cross-harness `<bare>-codex` disambiguation', async () => {
    // sync-globals' collision rule: when a plugin name collides across
    // harnesses (e.g. claude-code AND codex both have `superpowers`), the
    // codex-side entry is recorded with a `-codex` suffix in the registry.
    // The codex compose must reverse that suffix when matching back to
    // config.toml's bare name.
    const real = await makeFakeCodexHome();
    const r = await composeCodexHome({
      realCodexHome: real,
      skillsKeep: [],
      pluginsKeep: ['p1-codex'], // codex-suffix form (registry's collision name)
    });
    const parsed = TOML.parse(
      await fs.readFile(path.join(r.tempCodexHome, 'config.toml'), 'utf8'),
    ) as any;
    expect(parsed.plugins['p1@market-a'].enabled).toBe(true);
    expect(parsed.plugins['p2@market-a'].enabled).toBe(false);
  });

  it('mcpsKeep matches cross-harness `<id>-codex` disambiguation', async () => {
    const real = await makeFakeCodexHome();
    const r = await composeCodexHome({
      realCodexHome: real,
      skillsKeep: [],
      mcpsKeep: ['keep1-codex', 'keep2-codex'], // codex-suffix form
    });
    const parsed = TOML.parse(
      await fs.readFile(path.join(r.tempCodexHome, 'config.toml'), 'utf8'),
    ) as any;
    expect(parsed.mcp_servers.keep1.enabled).toBeUndefined();
    expect(parsed.mcp_servers.keep2.enabled).toBeUndefined();
    expect(parsed.mcp_servers.drop1.enabled).toBe(false);
  });

  it('mcpsKeep flips enabled=false on non-kept mcp_servers blocks', async () => {
    const real = await makeFakeCodexHome();
    const r = await composeCodexHome({
      realCodexHome: real,
      skillsKeep: [],
      mcpsKeep: ['keep1', 'keep2'],
    });
    const parsed = TOML.parse(
      await fs.readFile(path.join(r.tempCodexHome, 'config.toml'), 'utf8'),
    ) as any;
    expect(parsed.mcp_servers.keep1.enabled).toBeUndefined(); // not flipped
    expect(parsed.mcp_servers.drop1.enabled).toBe(false);
    expect(parsed.mcp_servers.keep2.enabled).toBeUndefined();
  });

  it('preserves non-plugin/non-mcp top-level keys verbatim', async () => {
    const real = await makeFakeCodexHome();
    const r = await composeCodexHome({
      realCodexHome: real,
      skillsKeep: [],
      pluginsKeep: [],
      mcpsKeep: [],
    });
    const parsed = TOML.parse(
      await fs.readFile(path.join(r.tempCodexHome, 'config.toml'), 'utf8'),
    ) as any;
    expect(parsed.approval_policy).toBe('never');
    expect(parsed.model).toBe('gpt-5.5');
    expect(parsed.features.external_migration).toBe(true);
    expect(parsed.marketplaces.example.source_type).toBe('git');
  });

  it('empty pluginsKeep disables every plugin block', async () => {
    const real = await makeFakeCodexHome();
    const r = await composeCodexHome({
      realCodexHome: real,
      skillsKeep: [],
      pluginsKeep: [],
    });
    const parsed = TOML.parse(
      await fs.readFile(path.join(r.tempCodexHome, 'config.toml'), 'utf8'),
    ) as any;
    for (const k of Object.keys(parsed.plugins)) {
      expect(parsed.plugins[k].enabled).toBe(false);
    }
  });

  it('missing config.toml falls through gracefully', async () => {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-empty-'));
    await fs.mkdir(path.join(real, 'skills'), { recursive: true });
    const r = await composeCodexHome({
      realCodexHome: real,
      skillsKeep: [],
      pluginsKeep: ['anything'],
    });
    // tempCodexHome should exist with a skills dir but no config.toml.
    await expect(fs.access(path.join(r.tempCodexHome, 'config.toml'))).rejects.toThrow();
  });

  it('malformed config.toml is symlinked through (codex surfaces the error)', async () => {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bad-'));
    await fs.writeFile(path.join(real, 'config.toml'), '$$ this is not toml\n[[[');
    await fs.mkdir(path.join(real, 'skills'), { recursive: true });
    const r = await composeCodexHome({
      realCodexHome: real,
      skillsKeep: [],
      pluginsKeep: ['anything'],
    });
    const stat = await fs.lstat(path.join(r.tempCodexHome, 'config.toml'));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('when neither pluginsKeep nor mcpsKeep is provided, config.toml is symlinked', async () => {
    const real = await makeFakeCodexHome();
    const r = await composeCodexHome({
      realCodexHome: real,
      skillsKeep: [],
    });
    const stat = await fs.lstat(path.join(r.tempCodexHome, 'config.toml'));
    expect(stat.isSymbolicLink()).toBe(true);
  });
});
