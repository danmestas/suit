import { describe, it, expect } from 'vitest';
import { claudeCodeAdapter } from '../adapters/claude-code.ts';
import { apmAdapter } from '../adapters/apm.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { copilotAdapter } from '../adapters/copilot.ts';
import { geminiAdapter } from '../adapters/gemini.ts';
import { piAdapter } from '../adapters/pi.ts';
import type { ComponentSource, AdapterContext } from '../lib/types.ts';

const adapters = [
  ['claude-code', claudeCodeAdapter],
  ['apm', apmAdapter],
  ['codex', codexAdapter],
  ['copilot', copilotAdapter],
  ['gemini', geminiAdapter],
  ['pi', piAdapter],
] as const;

const ctx: AdapterContext = { allComponents: [], config: {}, repoRoot: '/tmp' };

function fixture(type: 'outfit' | 'mode'): ComponentSource {
  return {
    relativeDir: `${type}s/test`,
    dir: `/tmp/${type}s/test`,
    body: '',
    manifest: {
      name: 'test',
      version: '1.0.0',
      type,
      description: '',
      targets: ['claude-code', 'apm', 'codex', 'copilot', 'gemini', 'pi'],
      categories: ['tooling'],
      skill_include: [],
      skill_exclude: [],
    } as any,
  };
}

function accessoryFixture(): ComponentSource {
  return {
    relativeDir: `accessories/test`,
    dir: `/tmp/accessories/test`,
    body: '',
    manifest: {
      name: 'test',
      version: '1.0.0',
      type: 'accessory',
      description: '',
      targets: ['claude-code', 'apm', 'codex', 'copilot', 'gemini', 'pi'],
      include: { skills: [], rules: [], hooks: [], agents: [], commands: [] },
    } as any,
  };
}

describe('adapters: outfit/mode are no-ops', () => {
  for (const [name, adapter] of adapters) {
    it(`${name}: outfit returns []`, async () => {
      const out = await adapter.emit(fixture('outfit'), ctx);
      expect(out).toEqual([]);
    });
    it(`${name}: mode returns []`, async () => {
      const out = await adapter.emit(fixture('mode'), ctx);
      expect(out).toEqual([]);
    });
  }
});

describe('adapters: accessory is a no-op', () => {
  for (const [name, adapter] of adapters) {
    it(`${name}: accessory returns []`, async () => {
      const out = await adapter.emit(accessoryFixture(), ctx);
      expect(out).toEqual([]);
    });
  }
});
