import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { resolve } from '../lib/resolution.ts';
import { composeHarnessHome } from '../lib/ac/symlink-farm.ts';
import { composeCodexHome } from '../lib/ac/codex-home.ts';

/**
 * v0.8 e2e: a single outfit declaring `disable.plugins: [foo, bar]` should
 * cause both the claude-code and codex composed tempdirs to disable their
 * respective `foo`/`bar` entries when the registry carries both harness
 * variants. Verifies the resolver-to-filter pipeline end-to-end without
 * spawning a real harness binary.
 */
describe('v0.8 cross-harness globals filtering — outfit disables both halves', () => {
  it('outfit.disable.plugins:[foo] disables foo on both harnesses', async () => {
    // Registry carries `foo` on claude-code (bare slot) and `foo-codex` (codex
    // disambiguation), plus an `bar` only on codex.
    const globals = {
      schemaVersion: 1 as const,
      generated_at: 't',
      machine: 'h',
      plugins: {
        foo: {
          source: 'manual' as const,
          install: 'claude plugin install foo',
          discover_path: '~/.claude/plugins/cache/m/foo/1.0.0',
        },
        'foo-codex': {
          source: 'codex-marketplace' as const,
          install: 'codex plugin install foo',
          discover_path: '~/.codex/plugins/cache/m/foo',
          harness: 'codex' as const,
        },
        bar: {
          source: 'codex-marketplace' as const,
          install: 'codex plugin install bar',
          discover_path: '~/.codex/plugins/cache/m/bar',
          harness: 'codex' as const,
        },
      },
      mcps: {},
      hooks: {},
    };

    const outfit = {
      name: 'minimal',
      type: 'outfit' as const,
      categories: [],
      skill_include: [],
      skill_exclude: [],
      enable: { plugins: [], mcps: [], hooks: [] },
      disable: { plugins: ['foo', 'foo-codex', 'bar'], mcps: [], hooks: [] },
    } as any;

    // Resolve for each harness. Each session sees only its own entries.
    const cc = resolve({ catalog: [], outfit, harness: 'claude-code', globals });
    expect(cc.metadata.globals.plugins.kept).toEqual([]);
    expect(cc.metadata.globals.plugins.dropped).toEqual(['foo']);

    const cx = resolve({ catalog: [], outfit, harness: 'codex', globals });
    expect(cx.metadata.globals.plugins.kept).toEqual([]);
    expect(cx.metadata.globals.plugins.dropped.sort()).toEqual(['bar', 'foo-codex']);

    // Build a fake claude-code home with foo installed and verify the rewritten
    // installed_plugins.json drops it.
    const ccHome = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-cc-home-'));
    await fs.mkdir(path.join(ccHome, '.claude', 'skills'), { recursive: true });
    await fs.mkdir(path.join(ccHome, '.claude', 'plugins'), { recursive: true });
    await fs.writeFile(
      path.join(ccHome, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'foo@market-a': [{ scope: 'user', version: '1.0.0' }] },
      }),
    );
    await fs.writeFile(path.join(ccHome, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    const ccComposed = await composeHarnessHome({
      target: 'claude-code',
      realHome: ccHome,
      skillsKeep: [],
      pluginsKeep: cc.metadata.globals.plugins.kept,
      mcpsKeep: cc.metadata.globals.mcps.kept,
    });
    const ccManifest = JSON.parse(
      await fs.readFile(
        path.join(ccComposed.tempHome, '.claude', 'plugins', 'installed_plugins.json'),
        'utf8',
      ),
    );
    expect(ccManifest.plugins).toEqual({}); // foo was dropped

    // Build a fake codex home with foo + bar installed and verify config.toml
    // sets enabled=false on each.
    const realCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-cx-home-'));
    await fs.mkdir(path.join(realCodexHome, 'skills'), { recursive: true });
    await fs.writeFile(
      path.join(realCodexHome, 'config.toml'),
      [
        '[plugins."foo@market-x"]',
        'enabled = true',
        '',
        '[plugins."bar@market-y"]',
        'enabled = true',
        '',
      ].join('\n'),
    );
    const cxComposed = await composeCodexHome({
      realCodexHome,
      skillsKeep: [],
      pluginsKeep: cx.metadata.globals.plugins.kept,
      mcpsKeep: cx.metadata.globals.mcps.kept,
    });
    const cxToml = TOML.parse(
      await fs.readFile(path.join(cxComposed.tempCodexHome, 'config.toml'), 'utf8'),
    ) as any;
    expect(cxToml.plugins['foo@market-x'].enabled).toBe(false);
    expect(cxToml.plugins['bar@market-y'].enabled).toBe(false);

    await ccComposed.cleanup();
    await cxComposed.cleanup();
  });
});
