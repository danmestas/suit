import { describe, it, expect } from 'vitest';
import { resolve } from '../lib/resolution.ts';

const mixedGlobals = (): any => ({
  schemaVersion: 1 as const,
  generated_at: 't',
  machine: 'h',
  plugins: {
    'cc-only': {
      source: 'manual',
      install: 'claude plugin install cc-only',
      discover_path: '~/.claude/plugins/cc-only',
      // harness omitted → claude-code
    },
    'codex-only': {
      source: 'codex-marketplace',
      install: 'codex plugin install codex-only',
      discover_path: '~/.codex/plugins/cache/m/codex-only',
      harness: 'codex',
    },
  },
  mcps: {
    'cc-mcp': {
      source: 'claude-code-config',
      type: 'stdio',
      command: 'cc',
      has_env: false,
      discover_path: '~/.claude.json#mcpServers.cc-mcp',
    },
    'codex-mcp': {
      source: 'codex-config',
      type: 'stdio',
      command: 'cx',
      has_env: false,
      discover_path: '~/.codex/config.toml#mcp_servers.codex-mcp',
      harness: 'codex',
    },
  },
  hooks: {},
});

describe('resolve — v0.8 harness-scoped globals filtering', () => {
  it('claude-code session sees only claude-code entries in baseline', () => {
    const r = resolve({ catalog: [], harness: 'claude-code', globals: mixedGlobals() });
    expect(r.metadata.globals.plugins.kept).toEqual(['cc-only']);
    expect(r.metadata.globals.plugins.dropped).toEqual([]);
    expect(r.metadata.globals.mcps.kept).toEqual(['cc-mcp']);
  });

  it('codex session sees only codex entries in baseline', () => {
    const r = resolve({ catalog: [], harness: 'codex', globals: mixedGlobals() });
    expect(r.metadata.globals.plugins.kept).toEqual(['codex-only']);
    expect(r.metadata.globals.plugins.dropped).toEqual([]);
    expect(r.metadata.globals.mcps.kept).toEqual(['codex-mcp']);
  });

  it('non-claude/non-codex harnesses get empty kept/dropped sets', () => {
    for (const h of ['gemini', 'copilot', 'apm', 'pi'] as const) {
      const r = resolve({ catalog: [], harness: h, globals: mixedGlobals() });
      expect(r.metadata.globals.plugins.kept).toEqual([]);
      expect(r.metadata.globals.plugins.dropped).toEqual([]);
      expect(r.metadata.globals.mcps.kept).toEqual([]);
    }
  });

  it('outfit.disable on a name from the OTHER harness is a silent no-op (no warning)', () => {
    const warns: string[] = [];
    const outfit = {
      name: 'p', type: 'outfit', categories: [], skill_include: [], skill_exclude: [],
      enable: { plugins: [], mcps: [], hooks: [] },
      // codex-only belongs to codex; in a claude-code session it shouldn't drop anything.
      disable: { plugins: ['codex-only'], mcps: [], hooks: [] },
    } as any;
    const r = resolve({
      catalog: [],
      outfit,
      harness: 'claude-code',
      globals: mixedGlobals(),
      warn: (m) => warns.push(m),
    });
    expect(r.metadata.globals.plugins.kept).toEqual(['cc-only']);
    expect(warns).toEqual([]);
  });

  it('outfit.enable on a name from the OTHER harness is a silent no-op (no warning, no unresolved)', () => {
    const warns: string[] = [];
    const outfit = {
      name: 'p', type: 'outfit', categories: [], skill_include: [], skill_exclude: [],
      // codex-only exists in the registry but belongs to codex — in a
      // claude-code session, it doesn't apply, but it's not "unresolved"
      // either. We silently skip cross-harness references so a single outfit
      // can carry both harnesses' enable lists.
      enable: { plugins: ['codex-only'], mcps: [], hooks: [] },
      disable: { plugins: [], mcps: [], hooks: [] },
    } as any;
    const r = resolve({
      catalog: [],
      outfit,
      harness: 'claude-code',
      globals: mixedGlobals(),
      warn: (m) => warns.push(m),
    });
    expect(r.metadata.globals.plugins.kept).toEqual(['cc-only']);
    expect(r.metadata.globals.plugins.unresolved).toEqual([]);
    expect(warns).toEqual([]);
  });

  it('outfit.disable applied to a codex session does drop matching codex entries', () => {
    const outfit = {
      name: 'p', type: 'outfit', categories: [], skill_include: [], skill_exclude: [],
      enable: { plugins: [], mcps: [], hooks: [] },
      disable: { plugins: ['codex-only'], mcps: [], hooks: [] },
    } as any;
    const r = resolve({ catalog: [], outfit, harness: 'codex', globals: mixedGlobals() });
    expect(r.metadata.globals.plugins.kept).toEqual([]);
    expect(r.metadata.globals.plugins.dropped).toEqual(['codex-only']);
  });

  it('outfit referencing genuinely-unknown name still warns and tracks unresolved', () => {
    const warns: string[] = [];
    const outfit = {
      name: 'p', type: 'outfit', categories: [], skill_include: [], skill_exclude: [],
      enable: { plugins: ['ghost'], mcps: [], hooks: [] },
      disable: { plugins: [], mcps: [], hooks: [] },
    } as any;
    const r = resolve({
      catalog: [],
      outfit,
      harness: 'claude-code',
      globals: mixedGlobals(),
      warn: (m) => warns.push(m),
    });
    expect(r.metadata.globals.plugins.unresolved).toEqual(['ghost']);
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatch(/ghost/);
  });
});
