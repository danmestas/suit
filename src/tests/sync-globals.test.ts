import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { buildGlobalsSnapshot, renderGlobalsYaml } from '../lib/sync-globals.ts';
import { GlobalsRegistrySchema } from '../lib/globals-schema.ts';

interface InstalledPluginEntry {
  scope: 'user' | 'project' | 'local';
  installPath?: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  projectPath?: string;
}

async function makeFakeHome(): Promise<{ home: string; pluginsDir: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'globals-home-'));
  const pluginsDir = path.join(home, '.claude', 'plugins');
  await fs.mkdir(pluginsDir, { recursive: true });
  return { home, pluginsDir };
}

async function writeInstalledPlugins(
  home: string,
  plugins: Record<string, InstalledPluginEntry[]>,
): Promise<void> {
  const file = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 2, plugins }));
}

describe('buildGlobalsSnapshot', () => {
  it('produces an empty-but-valid snapshot when ~/.claude is missing', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'globals-empty-'));
    const snap = await buildGlobalsSnapshot({
      home,
      hostname: 'test-host',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(snap.schemaVersion).toBe(1);
    expect(snap.machine).toBe('test-host');
    expect(snap.generated_at).toBe('2026-01-01T00:00:00.000Z');
    expect(snap.plugins).toEqual({});
    expect(snap.mcps).toEqual({});
    expect(snap.hooks).toEqual({});
    expect(() => GlobalsRegistrySchema.parse(snap)).not.toThrow();
  });

  it('returns empty plugins when installed_plugins.json is absent', async () => {
    const { home } = await makeFakeHome();
    const snap = await buildGlobalsSnapshot({ home, hostname: 'h', now: 't' });
    expect(snap.plugins).toEqual({});
  });

  it('discovers a single user-scope plugin from installed_plugins.json', async () => {
    const { home } = await makeFakeHome();
    await writeInstalledPlugins(home, {
      'superpowers@claude-plugins-official': [
        {
          scope: 'user',
          installPath:
            path.join(home, '.claude/plugins/cache/claude-plugins-official/superpowers/1.0.0'),
          version: '1.0.0',
          installedAt: '2026-01-22T19:43:28.680Z',
          lastUpdated: '2026-03-17T23:30:53.781Z',
        },
      ],
    });
    const snap = await buildGlobalsSnapshot({ home, hostname: 'h', now: 't' });
    expect(snap.plugins.superpowers).toBeDefined();
    expect(snap.plugins.superpowers!.source).toBe('claude-code-marketplace');
    expect(snap.plugins.superpowers!.install).toBe('claude plugin install superpowers');
    expect(snap.plugins.superpowers!.discover_path).toBe(
      '~/.claude/plugins/cache/claude-plugins-official/superpowers/1.0.0',
    );
    expect(snap.plugins.superpowers!.version).toBe('1.0.0');
  });

  it('skips a project-scope-only plugin (no user-scope entry)', async () => {
    const { home } = await makeFakeHome();
    await writeInstalledPlugins(home, {
      'gopls-lsp@claude-plugins-official': [
        {
          scope: 'project',
          projectPath: '/Users/dev/projects/foo',
          installPath: '/x/y',
          version: '1.0.0',
          lastUpdated: '2026-03-19T12:22:10.801Z',
        },
      ],
    });
    const snap = await buildGlobalsSnapshot({ home, hostname: 'h', now: 't' });
    expect(snap.plugins).toEqual({});
  });

  it('keeps the user-scope entry even when project-scope siblings exist', async () => {
    const { home } = await makeFakeHome();
    await writeInstalledPlugins(home, {
      'gopls-lsp@claude-plugins-official': [
        {
          scope: 'user',
          installPath: path.join(
            home,
            '.claude/plugins/cache/claude-plugins-official/gopls-lsp/1.0.0',
          ),
          version: '1.0.0',
          lastUpdated: '2026-04-03T14:54:01.363Z',
        },
        {
          scope: 'project',
          projectPath: '/Users/dev/projects/foo',
          installPath: '/somewhere/else',
          version: '1.0.0',
          lastUpdated: '2026-03-19T12:22:10.801Z',
        },
      ],
    });
    const snap = await buildGlobalsSnapshot({ home, hostname: 'h', now: 't' });
    expect(Object.keys(snap.plugins)).toEqual(['gopls-lsp']);
    expect(snap.plugins['gopls-lsp']!.discover_path).toBe(
      '~/.claude/plugins/cache/claude-plugins-official/gopls-lsp/1.0.0',
    );
  });

  it('disambiguates name collisions across marketplaces', async () => {
    const { home } = await makeFakeHome();
    await writeInstalledPlugins(home, {
      'superpowers@claude-plugins-official': [
        {
          scope: 'user',
          installPath: path.join(
            home,
            '.claude/plugins/cache/claude-plugins-official/superpowers/1.0.0',
          ),
          version: '1.0.0',
          lastUpdated: '2026-03-17T23:30:53.781Z',
        },
      ],
      'superpowers@other-marketplace': [
        {
          scope: 'user',
          installPath: path.join(
            home,
            '.claude/plugins/cache/other-marketplace/superpowers/2.0.0',
          ),
          version: '2.0.0',
          lastUpdated: '2026-03-17T23:30:53.781Z',
        },
      ],
    });
    const snap = await buildGlobalsSnapshot({ home, hostname: 'h', now: 't' });
    expect(Object.keys(snap.plugins).sort()).toEqual([
      'superpowers-claude-plugins-official',
      'superpowers-other-marketplace',
    ]);
    expect(snap.plugins['superpowers-claude-plugins-official']!.source).toBe(
      'claude-code-marketplace',
    );
    expect(snap.plugins['superpowers-other-marketplace']!.source).toBe('manual');
    // Each install command still uses the bare plugin name (the marketplace
    // suffix is for the registry key, not the install hint).
    expect(snap.plugins['superpowers-claude-plugins-official']!.install).toBe(
      'claude plugin install superpowers',
    );
  });

  it('classifies third-party marketplaces as `manual`', async () => {
    const { home } = await makeFakeHome();
    await writeInstalledPlugins(home, {
      'context-mode@context-mode': [
        {
          scope: 'user',
          installPath: path.join(home, '.claude/plugins/cache/context-mode/context-mode/0.5.1'),
          version: '0.5.1',
          lastUpdated: '2026-03-17T23:30:53.781Z',
        },
      ],
    });
    const snap = await buildGlobalsSnapshot({ home, hostname: 'h', now: 't' });
    expect(snap.plugins['context-mode']!.source).toBe('manual');
    expect(snap.plugins['context-mode']!.version).toBe('0.5.1');
  });

  it('omits version when the entry version is non-semver (e.g. "unknown")', async () => {
    const { home } = await makeFakeHome();
    await writeInstalledPlugins(home, {
      'context7@claude-plugins-official': [
        {
          scope: 'user',
          installPath: path.join(
            home,
            '.claude/plugins/cache/claude-plugins-official/context7/unknown',
          ),
          version: 'unknown',
          lastUpdated: '2026-04-13T15:34:16.076Z',
        },
      ],
    });
    const snap = await buildGlobalsSnapshot({ home, hostname: 'h', now: 't' });
    expect(snap.plugins.context7).toBeDefined();
    expect(snap.plugins.context7!.version).toBeUndefined();
  });

  it('does not treat internal plugin subdirs (cache/, repos/, …) as plugins', async () => {
    // Even with sibling internal dirs present, the registry only reads
    // installed_plugins.json — so an empty file means no plugins, full stop.
    const { home, pluginsDir } = await makeFakeHome();
    for (const internal of ['cache', 'data', 'marketplaces', 'repos']) {
      await fs.mkdir(path.join(pluginsDir, internal), { recursive: true });
    }
    await writeInstalledPlugins(home, {});
    const snap = await buildGlobalsSnapshot({ home, hostname: 'h', now: 't' });
    expect(snap.plugins).toEqual({});
  });

  it('discovers stdio mcps from ~/.claude.json with non-secret metadata only', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'globals-mcp-'));
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          'doppler-cli': {
            command: 'doppler',
            args: ['mcp'],
            env: { DOPPLER_TOKEN: 'secret-token-xxx' },
          },
          axiom: {
            command: 'npx',
            args: ['-y', '@axiomhq/mcp'],
          },
        },
      }),
    );
    const snap = await buildGlobalsSnapshot({ home, hostname: 'h', now: 't' });
    const doppler = snap.mcps['doppler-cli'];
    expect(doppler).toBeDefined();
    if (doppler!.type !== 'stdio') throw new Error('expected stdio');
    expect(doppler!.source).toBe('claude-code-config');
    expect(doppler!.command).toBe('doppler');
    expect(doppler!.args).toEqual(['mcp']);
    expect(doppler!.has_env).toBe(true);
    expect(doppler!.discover_path).toBe('~/.claude.json#mcpServers.doppler-cli');
    expect(JSON.stringify(doppler)).not.toContain('secret-token-xxx');
    expect(JSON.stringify(doppler)).not.toContain('DOPPLER_TOKEN');
    const axiom = snap.mcps.axiom;
    if (axiom!.type !== 'stdio') throw new Error('expected stdio');
    expect(axiom!.has_env).toBe(false);
    expect(axiom!.command).toBe('npx');
  });

  it('discovers http mcps without leaking header values', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'globals-mcp-http-'));
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          axiom: {
            type: 'http',
            url: 'https://mcp.axiom.co/mcp',
            headers: {
              Authorization: 'Bearer super-secret-bearer-xxx',
              'x-axiom-org-id': 'craft-design-8rmi',
            },
          },
          'no-headers': {
            type: 'http',
            url: 'https://example.com/mcp',
          },
        },
      }),
    );
    const snap = await buildGlobalsSnapshot({ home, hostname: 'h', now: 't' });
    const axiom = snap.mcps.axiom;
    expect(axiom).toBeDefined();
    if (axiom!.type !== 'http') throw new Error('expected http');
    expect(axiom!.url).toBe('https://mcp.axiom.co/mcp');
    expect(axiom!.has_headers).toBe(true);
    expect(axiom!.discover_path).toBe('~/.claude.json#mcpServers.axiom');
    const serialized = JSON.stringify(axiom);
    expect(serialized).not.toContain('super-secret-bearer-xxx');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('craft-design-8rmi');

    const empty = snap.mcps['no-headers'];
    if (empty!.type !== 'http') throw new Error('expected http');
    expect(empty!.has_headers).toBe(false);
  });

  it('infers http transport from a top-level `url` even without explicit type', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'globals-mcp-urlonly-'));
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          'http-implicit': {
            url: 'https://example.com/mcp',
          },
        },
      }),
    );
    const snap = await buildGlobalsSnapshot({ home, hostname: 'h', now: 't' });
    const entry = snap.mcps['http-implicit'];
    if (entry!.type !== 'http') throw new Error('expected http');
    expect(entry!.url).toBe('https://example.com/mcp');
    expect(entry!.has_headers).toBe(false);
  });

  it('schema accepts both stdio and http MCP shapes', () => {
    const stdio = {
      schemaVersion: 1,
      generated_at: 't',
      machine: 'h',
      plugins: {},
      mcps: {
        doppler: {
          source: 'claude-code-config',
          type: 'stdio',
          command: 'doppler',
          has_env: true,
          discover_path: '~/.claude.json#mcpServers.doppler',
        },
      },
      hooks: {},
    };
    expect(() => GlobalsRegistrySchema.parse(stdio)).not.toThrow();
    const http = {
      ...stdio,
      mcps: {
        axiom: {
          source: 'claude-code-config',
          type: 'http',
          url: 'https://mcp.axiom.co/mcp',
          has_headers: true,
          discover_path: '~/.claude.json#mcpServers.axiom',
        },
      },
    };
    expect(() => GlobalsRegistrySchema.parse(http)).not.toThrow();
  });

  it('round-trips through YAML via renderGlobalsYaml without leaking env values', async () => {
    const { home } = await makeFakeHome();
    await writeInstalledPlugins(home, {
      'foo@claude-plugins-official': [
        {
          scope: 'user',
          installPath: path.join(
            home,
            '.claude/plugins/cache/claude-plugins-official/foo/1.0.0',
          ),
          version: '1.0.0',
          lastUpdated: '2026-03-17T23:30:53.781Z',
        },
      ],
    });
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          bar: { command: 'bar', args: [], env: { SECRET_KEY: 'leak-me' } },
        },
      }),
    );
    const snap = await buildGlobalsSnapshot({
      home,
      hostname: 'workstation-1',
      now: '2026-05-04T12:00:00.000Z',
    });
    const yaml = renderGlobalsYaml(snap);
    expect(yaml).not.toContain('leak-me');
    expect(yaml).not.toContain('SECRET_KEY');
    const parsed = YAML.parse(yaml);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.machine).toBe('workstation-1');
    expect(parsed.plugins.foo.discover_path).toBe(
      '~/.claude/plugins/cache/claude-plugins-official/foo/1.0.0',
    );
    expect(parsed.mcps.bar.command).toBe('bar');
    expect(parsed.mcps.bar.has_env).toBe(true);
    expect(parsed.mcps.bar.type).toBe('stdio');
    expect(() => GlobalsRegistrySchema.parse(parsed)).not.toThrow();
  });
});
