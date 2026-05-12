import { describe, expect, it } from 'vitest';
import {
  PermissionsBlockSchema,
  OutfitSchema,
  CutSchema,
  AccessorySchema,
} from '../lib/schema.ts';

describe('PermissionsBlockSchema', () => {
  it('accepts an empty block', () => {
    expect(() => PermissionsBlockSchema.parse({})).not.toThrow();
  });

  it('accepts all four target sub-blocks with opaque content', () => {
    const input = {
      'claude-code': { allow: ['Bash(git status:*)'], deny: ['Bash(rm -rf:*)'] },
      codex: {
        sandbox_mode: 'workspace-write',
        rules: { prefix_rules: [{ prefix: 'git ' }] },
      },
      gemini: {
        security: { folderTrust: { enabled: true } },
        mcpServers: { signoz: { enabled: true } },
      },
      pi: { tools: ['read', 'bash'] },
    };
    expect(() => PermissionsBlockSchema.parse(input)).not.toThrow();
  });

  it('rejects unknown top-level keys (no LCD vocabulary in v1)', () => {
    expect(() => PermissionsBlockSchema.parse({ mode: 'default' })).toThrow();
    expect(() => PermissionsBlockSchema.parse({ bash_allow: ['git'] })).toThrow();
    expect(() => PermissionsBlockSchema.parse({ mcp: {} })).toThrow();
    expect(() => PermissionsBlockSchema.parse({ claude: {} })).toThrow();
  });

  it('rejects null target blocks', () => {
    expect(() => PermissionsBlockSchema.parse({ 'claude-code': null })).toThrow();
  });
});

describe('Permissions attachment', () => {
  const base = {
    name: 'x',
    description: 'd',
    targets: ['claude-code'],
    categories: [],
  };

  it('outfit accepts permissions block', () => {
    expect(() =>
      OutfitSchema.parse({
        ...base,
        type: 'outfit',
        permissions: { 'claude-code': { allow: [] } },
      }),
    ).not.toThrow();
  });

  it('cut rejects permissions block in v1', () => {
    expect(() =>
      CutSchema.parse({
        ...base,
        type: 'cut',
        permissions: { 'claude-code': { allow: [] } },
      }),
    ).toThrow();
  });

  it('accessory rejects permissions block in v1', () => {
    expect(() =>
      AccessorySchema.parse({
        ...base,
        type: 'accessory',
        permissions: { 'claude-code': { allow: [] } },
      }),
    ).toThrow();
  });
});
