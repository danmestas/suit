import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import matter from 'gray-matter';
import { claudeCodeAdapter } from '../../adapters/claude-code.ts';
import { ManifestSchema } from '../../lib/schema.ts';
import type { ComponentSource } from '../../lib/types.ts';
import { runGolden } from './golden.ts';
import { mergeBuffers } from '../../lib/merge.ts';

const HERE = path.resolve(fileURLToPath(import.meta.url), '..');

async function loadComponent(dir: string, repoRoot: string): Promise<ComponentSource> {
  const raw = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  const parsed = matter(raw);
  return {
    dir,
    relativeDir: path.relative(repoRoot, dir),
    manifest: ManifestSchema.parse(parsed.data),
    body: parsed.content,
  };
}

describe('claude-code adapter', () => {
  it('emits a basic skill correctly', async () => {
    const result = await runGolden(claudeCodeAdapter, path.join(HERE, 'claude-code/skill-basic'));
    expect(result.diff).toEqual([]);
    expect(result.matched).toBe(true);
  });

  it('emits an agent component', async () => {
    const result = await runGolden(claudeCodeAdapter, path.join(HERE, 'claude-code/agent-basic'));
    expect(result.diff).toEqual([]);
  });

  it('composes project rules into AGENTS.md plus a CLAUDE.md shim', async () => {
    const root = path.join(HERE, 'claude-code/rules-compose');
    const baseStyle = await loadComponent(path.join(root, 'component'), root);
    const prPolicy = await loadComponent(path.join(root, 'extra/rules/pr-policy'), root);
    const all = [baseStyle, prPolicy];
    const files = (
      await Promise.all(
        all.map((c) =>
          claudeCodeAdapter.emit(c, { config: {}, allComponents: all, repoRoot: root }),
        ),
      )
    ).flat();
    const expectedRules = await fs.readFile(path.join(root, 'expected/AGENTS.md'), 'utf8');
    expect(files.find((f) => f.path === 'AGENTS.md')?.content.toString()).toBe(
      expectedRules,
    );
    expect(files.find((f) => f.path === 'CLAUDE.md')?.content.toString()).toBe(
      '@AGENTS.md\n',
    );
    expect(files.filter((f) => f.path === 'AGENTS.md').length).toBe(1);
    expect(files.filter((f) => f.path === 'CLAUDE.md').length).toBe(1);
  });

  it('preserves user-scope rules in .claude/CLAUDE.md', async () => {
    const component: ComponentSource = {
      dir: HERE,
      relativeDir: 'rules/user-style',
      manifest: ManifestSchema.parse({
        name: 'user-style',
        version: '0.0.0',
        description: 'User style rules',
        type: 'rules',
        scope: 'user',
        targets: ['claude-code'],
      }),
      body: 'Keep personal Claude rules here.\n',
    };
    const files = await claudeCodeAdapter.emit(component, {
      config: {},
      allComponents: [component],
      repoRoot: HERE,
    });
    expect(files).toEqual([
      {
        path: '.claude/CLAUDE.md',
        content: '## user-style\n\nKeep personal Claude rules here.\n',
      },
    ]);
  });

  it('emits a hook component with settings fragment + script', async () => {
    const result = await runGolden(claudeCodeAdapter, path.join(HERE, 'claude-code/hook-basic'));
    expect(result.diff).toEqual([]);
  });

  it('emits an mcp component as .mcp.json', async () => {
    const result = await runGolden(claudeCodeAdapter, path.join(HERE, 'claude-code/mcp-basic'));
    expect(result.diff).toEqual([]);
  });

  it('emits multiple mcp components to the same mergeable .mcp.json path', async () => {
    const root = path.join(HERE, 'claude-code/mcp-basic');
    const first = await loadComponent(path.join(root, 'component'), root);
    const second: ComponentSource = {
      ...first,
      manifest: {
        ...first.manifest,
        name: 'other-mcp',
        mcp: {
          command: 'python',
          args: ['server.py'],
        },
      },
    };
    const firstEmit = await claudeCodeAdapter.emit(first, {
      config: {},
      allComponents: [first, second],
      repoRoot: root,
    });
    const secondEmit = await claudeCodeAdapter.emit(second, {
      config: {},
      allComponents: [first, second],
      repoRoot: root,
    });
    const firstMcp = firstEmit.find((f) => f.path === '.mcp.json');
    const secondMcp = secondEmit.find((f) => f.path === '.mcp.json');
    expect(firstMcp).toBeDefined();
    expect(secondMcp).toBeDefined();

    const merged = mergeBuffers('.mcp.json', firstMcp!.content, secondMcp!.content);
    expect(merged).not.toBeNull();
    expect(JSON.parse(merged!.toString())).toEqual({
      mcpServers: {
        'my-mcp': {
          command: 'node',
          args: ['server.js'],
          env: {
            LOG_LEVEL: 'debug',
          },
        },
        'other-mcp': {
          command: 'python',
          args: ['server.py'],
        },
      },
    });
  });

  it('emits a plugin component listing included skills', async () => {
    const root = path.join(HERE, 'claude-code/plugin-basic');
    const plugin = await loadComponent(path.join(root, 'component'), root);
    const skill = await loadComponent(path.join(root, 'sibling-skill'), root);
    const all = [plugin, skill];
    const emitted = await claudeCodeAdapter.emit(plugin, {
      config: {},
      allComponents: all,
      repoRoot: root,
    });
    const pluginJson = emitted.find((f) => f.path === '.claude-plugin/plugin.json');
    const expected = await fs.readFile(path.join(root, 'expected/.claude-plugin/plugin.json'), 'utf8');
    expect(pluginJson?.content.toString()).toBe(expected);
  });

  it('escapes YAML special chars in description and name', async () => {
    const result = await runGolden(claudeCodeAdapter, path.join(HERE, 'claude-code/skill-with-special-chars'));
    expect(result.diff).toEqual([]);
  });

  it('emits permissions.claude-code wrapped under settings.permissions key', async () => {
    const result = await runGolden(
      claudeCodeAdapter,
      path.join(HERE, 'claude-code/outfit-permissions'),
    );
    expect(result.diff).toEqual([]);
  });

  it('throws when hook references a missing script', async () => {
    // Reuse hook-basic fixture but mutate manifest in-memory to point at a non-existent script.
    const root = path.join(HERE, 'claude-code/hook-basic');
    const raw = await fs.readFile(path.join(root, 'component/SKILL.md'), 'utf8');
    const parsed = matter(raw);
    const manifest = ManifestSchema.parse({
      ...parsed.data,
      hooks: { Stop: { command: 'hooks/missing.sh' } },
    });
    const component: ComponentSource = {
      dir: path.join(root, 'component'),
      relativeDir: 'component',
      manifest,
      body: parsed.content,
    };
    await expect(
      claudeCodeAdapter.emit(component, { config: {}, allComponents: [component], repoRoot: root }),
    ).rejects.toThrow(/missing script/);
  });
});
