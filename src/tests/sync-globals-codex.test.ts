import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildGlobalsSnapshot } from '../lib/sync-globals.ts';
import { GlobalsRegistrySchema } from '../lib/globals-schema.ts';

async function makeCodexFixture(toml: string): Promise<{ home: string; codexHome: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-codex-home-'));
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), toml);
  return { home, codexHome };
}

describe('buildGlobalsSnapshot — codex (v0.8)', () => {
  it('returns empty codex contributions when config.toml is absent', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-codex-empty-'));
    const snap = await buildGlobalsSnapshot({
      home,
      codexHome: path.join(home, '.codex'),
      hostname: 'h',
      now: 't',
    });
    expect(snap.plugins).toEqual({});
    expect(snap.mcps).toEqual({});
  });

  it('discovers plugins from [plugins."<bare>@<marketplace>"] blocks', async () => {
    const { codexHome } = await makeCodexFixture(
      [
        '[plugins."superpowers@claude-plugins-official"]',
        'enabled = true',
        '',
        '[plugins."context-mode@context-mode"]',
        'enabled = false',
        '',
      ].join('\n'),
    );
    const snap = await buildGlobalsSnapshot({
      home: path.dirname(codexHome),
      codexHome,
      hostname: 'h',
      now: 't',
    });
    expect(snap.plugins.superpowers).toBeDefined();
    expect(snap.plugins.superpowers!.harness).toBe('codex');
    expect(snap.plugins.superpowers!.source).toBe('codex-marketplace');
    expect(snap.plugins['context-mode']).toBeDefined();
    expect(snap.plugins['context-mode']!.harness).toBe('codex');
  });

  it('discovers stdio mcp_servers without leaking env values', async () => {
    const { codexHome } = await makeCodexFixture(
      [
        '[mcp_servers.doppler]',
        'command = "npx"',
        'args = ["-y", "@dopplerhq/mcp-server"]',
        'env_vars = ["DOPPLER_TOKEN"]',
        '',
        '[mcp_servers.context-mode]',
        'command = "context-mode"',
        '',
      ].join('\n'),
    );
    const snap = await buildGlobalsSnapshot({
      home: path.dirname(codexHome),
      codexHome,
      hostname: 'h',
      now: 't',
    });
    const doppler = snap.mcps.doppler;
    expect(doppler).toBeDefined();
    if (doppler!.type !== 'stdio') throw new Error('expected stdio');
    expect(doppler!.harness).toBe('codex');
    expect(doppler!.source).toBe('codex-config');
    expect(doppler!.command).toBe('npx');
    expect(doppler!.args).toEqual(['-y', '@dopplerhq/mcp-server']);
    expect(doppler!.has_env).toBe(true);
    expect(JSON.stringify(doppler)).not.toContain('DOPPLER_TOKEN'); // env_vars name list is presence-only
    const cm = snap.mcps['context-mode'];
    if (cm!.type !== 'stdio') throw new Error('expected stdio');
    expect(cm!.has_env).toBe(false);
  });

  it('discovers http mcp_servers and flags has_headers without leaking values', async () => {
    const { codexHome } = await makeCodexFixture(
      [
        '[mcp_servers.axiom]',
        'bearer_token_env_var = "AXIOM_TOKEN"',
        'url = "https://mcp.axiom.co/mcp"',
        '',
        '[mcp_servers.axiom.http_headers]',
        'x-axiom-org-id = "craft-design-8rmi"',
        '',
      ].join('\n'),
    );
    const snap = await buildGlobalsSnapshot({
      home: path.dirname(codexHome),
      codexHome,
      hostname: 'h',
      now: 't',
    });
    const axiom = snap.mcps.axiom;
    expect(axiom).toBeDefined();
    if (axiom!.type !== 'http') throw new Error('expected http');
    expect(axiom!.harness).toBe('codex');
    expect(axiom!.url).toBe('https://mcp.axiom.co/mcp');
    expect(axiom!.has_headers).toBe(true);
    expect(JSON.stringify(axiom)).not.toContain('craft-design-8rmi');
  });

  it('cross-harness collisions: codex entry takes -codex suffix when claude-code holds the bare name', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-cross-'));
    // claude-code side: an mcp called "signoz"
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { signoz: { command: 'signoz-mcp-server' } } }),
    );
    // codex side: also "signoz"
    const codexHome = path.join(home, '.codex');
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      path.join(codexHome, 'config.toml'),
      ['[mcp_servers.signoz]', 'command = "signoz-codex"', ''].join('\n'),
    );
    const snap = await buildGlobalsSnapshot({ home, codexHome, hostname: 'h', now: 't' });
    expect(snap.mcps.signoz).toBeDefined(); // claude-code wins bare slot
    expect(snap.mcps.signoz!.harness).toBeUndefined(); // omitted = claude-code
    expect(snap.mcps['signoz-codex']).toBeDefined();
    expect(snap.mcps['signoz-codex']!.harness).toBe('codex');
  });

  it('schema accepts codex entries with explicit harness field', () => {
    const reg = {
      schemaVersion: 1,
      generated_at: 't',
      machine: 'h',
      plugins: {
        'plugin-a': {
          source: 'codex-marketplace',
          install: 'codex plugin install plugin-a',
          discover_path: '~/.codex/plugins/cache/m/plugin-a',
          harness: 'codex',
        },
      },
      mcps: {
        'mcp-a': {
          source: 'codex-config',
          type: 'stdio',
          command: 'foo',
          has_env: false,
          discover_path: '~/.codex/config.toml#mcp_servers.mcp-a',
          harness: 'codex',
        },
      },
      hooks: {},
    };
    expect(() => GlobalsRegistrySchema.parse(reg)).not.toThrow();
  });

  it('schema accepts mixed-harness registry (claude-code entries omit harness)', () => {
    const reg = {
      schemaVersion: 1,
      generated_at: 't',
      machine: 'h',
      plugins: {
        'cc-plugin': {
          source: 'manual',
          install: 'claude plugin install cc-plugin',
          discover_path: '~/.claude/plugins/cache/m/cc-plugin/1.0.0',
        },
        'codex-plugin': {
          source: 'codex-marketplace',
          install: 'codex plugin install codex-plugin',
          discover_path: '~/.codex/plugins/cache/m/codex-plugin',
          harness: 'codex',
        },
      },
      mcps: {},
      hooks: {},
    };
    expect(() => GlobalsRegistrySchema.parse(reg)).not.toThrow();
  });
});
