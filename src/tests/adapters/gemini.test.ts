import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import matter from 'gray-matter';
import { geminiAdapter } from '../../adapters/gemini.ts';
import { ManifestSchema } from '../../lib/schema.ts';
import type { ComponentSource } from '../../lib/types.ts';
import { runGolden } from './golden.ts';

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

describe('gemini adapter', () => {
  it('emits a skill with metadata.json + skill.md', async () => {
    const result = await runGolden(geminiAdapter, path.join(HERE, 'gemini/skill-basic'));
    expect(result.diff).toEqual([]);
    expect(result.matched).toBe(true);
  });

  it('composes project rules into AGENTS.md plus a GEMINI.md shim', async () => {
    const root = path.join(HERE, 'gemini/rules-compose');
    const baseStyle = await loadComponent(path.join(root, 'component'), root);
    const prPolicy = await loadComponent(path.join(root, 'extra/rules/pr-policy'), root);
    const all = [baseStyle, prPolicy];
    const files = (
      await Promise.all(
        all.map((c) =>
          geminiAdapter.emit(c, { config: {}, allComponents: all, repoRoot: root }),
        ),
      )
    ).flat();
    const expectedRules = await fs.readFile(path.join(root, 'expected/AGENTS.md'), 'utf8');
    expect(files.find((f) => f.path === 'AGENTS.md')?.content.toString()).toBe(
      expectedRules,
    );
    expect(files.find((f) => f.path === 'GEMINI.md')?.content.toString()).toBe(
      '@AGENTS.md\n',
    );
    expect(files.filter((f) => f.path === 'AGENTS.md').length).toBe(1);
    expect(files.filter((f) => f.path === 'GEMINI.md').length).toBe(1);
  });

  it('preserves user-scope rules in .gemini/GEMINI.md', async () => {
    const component: ComponentSource = {
      dir: HERE,
      relativeDir: 'rules/user-style',
      manifest: ManifestSchema.parse({
        name: 'user-style',
        version: '0.0.0',
        description: 'User style rules',
        type: 'rules',
        scope: 'user',
        targets: ['gemini'],
      }),
      body: 'Keep personal Gemini rules here.\n',
    };
    const files = await geminiAdapter.emit(component, {
      config: {},
      allComponents: [component],
      repoRoot: HERE,
    });
    expect(files).toEqual([
      {
        path: '.gemini/GEMINI.md',
        content: '## user-style\n\nKeep personal Gemini rules here.\n',
      },
    ]);
  });

  it('emits a hook component with .gemini/settings fragment + script', async () => {
    const result = await runGolden(geminiAdapter, path.join(HERE, 'gemini/hook-basic'));
    expect(result.diff).toEqual([]);
  });

  it('rejects a Claude Code event name (PreToolUse) on a Gemini hook', async () => {
    const root = path.join(HERE, 'gemini/hook-basic');
    const fakeManifest = {
      name: 'bad',
      version: '1.0.0',
      description: 'd',
      type: 'hook' as const,
      targets: ['gemini' as const],
      hooks: { PreToolUse: { command: 'hooks/x.sh' } },
    };
    const fake: ComponentSource = {
      dir: root,
      relativeDir: 'hooks/bad',
      body: '',
      manifest: fakeManifest as ComponentSource['manifest'],
    };
    await expect(
      geminiAdapter.emit(fake, { config: {}, allComponents: [fake], repoRoot: root }),
    ).rejects.toThrow(/PreToolUse/);
  });

  it('rejects a hook script that does not honor the JSON-on-stdout contract', async () => {
    await expect(
      runGolden(geminiAdapter, path.join(HERE, 'gemini/hook-bad-stdout')),
    ).rejects.toThrow(/JSON-on-stdout/);
  });

  it('emits an mcp component as .gemini/settings fragment with mcpServers', async () => {
    const result = await runGolden(geminiAdapter, path.join(HERE, 'gemini/mcp-basic'));
    expect(result.diff).toEqual([]);
  });

  it('emits an agent component as Markdown with YAML frontmatter', async () => {
    const result = await runGolden(geminiAdapter, path.join(HERE, 'gemini/agent-basic'));
    expect(result.diff).toEqual([]);
  });

  it('throws a clear error when emitting a plugin', async () => {
    const fake: ComponentSource = {
      dir: '/tmp/fake',
      relativeDir: 'plugins/fake',
      body: 'body',
      manifest: {
        name: 'fake',
        version: '1.0.0',
        description: 'd',
        type: 'plugin',
        targets: ['gemini'],
        includes: [],
      } as ComponentSource['manifest'],
    };
    await expect(
      geminiAdapter.emit(fake, { config: {}, allComponents: [fake], repoRoot: '/tmp/fake' }),
    ).rejects.toThrow(/not supported on Gemini/);
  });

  it('emits permissions.gemini verbatim into .gemini/settings.fragment.json', async () => {
    const result = await runGolden(
      geminiAdapter,
      path.join(HERE, 'gemini/outfit-permissions'),
    );
    expect(result.diff).toEqual([]);
  });
});
