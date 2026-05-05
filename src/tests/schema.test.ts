import { describe, it, expect } from 'vitest';
import { ManifestSchema, OutfitSchema, ModeSchema, AccessorySchema } from '../lib/schema.ts';

describe('ManifestSchema', () => {
  it('accepts a minimal valid skill manifest', () => {
    const result = ManifestSchema.safeParse({
      name: 'my-skill',
      version: '1.0.0',
      description: 'Does a thing',
      type: 'skill',
      targets: ['claude-code'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown component type', () => {
    const result = ManifestSchema.safeParse({
      name: 'x',
      version: '1.0.0',
      description: 'd',
      type: 'unknown',
      targets: ['claude-code'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid semver', () => {
    const result = ManifestSchema.safeParse({
      name: 'x',
      version: 'not-semver',
      description: 'd',
      type: 'skill',
      targets: ['claude-code'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects names with invalid characters', () => {
    const result = ManifestSchema.safeParse({
      name: 'My Skill',
      version: '1.0.0',
      description: 'd',
      type: 'skill',
      targets: ['claude-code'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts hook manifest with hooks block', () => {
    const result = ManifestSchema.safeParse({
      name: 'tts',
      version: '1.0.0',
      description: 'd',
      type: 'hook',
      targets: ['claude-code'],
      hooks: { Stop: { command: 'hooks/announce.sh' } },
    });
    expect(result.success).toBe(true);
  });

  describe('category field', () => {
    it('accepts manifest with category.primary only', () => {
      const result = ManifestSchema.safeParse({
        name: 'x',
        version: '1.0.0',
        description: 'd',
        type: 'skill',
        targets: ['claude-code'],
        category: { primary: 'economy' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts manifest with primary and secondary[]', () => {
      const result = ManifestSchema.safeParse({
        name: 'x',
        version: '1.0.0',
        description: 'd',
        type: 'skill',
        targets: ['claude-code'],
        category: { primary: 'tooling', secondary: ['economy'] },
      });
      expect(result.success).toBe(true);
    });

    it('rejects unknown category value', () => {
      const result = ManifestSchema.safeParse({
        name: 'x',
        version: '1.0.0',
        description: 'd',
        type: 'skill',
        targets: ['claude-code'],
        category: { primary: 'not-a-real-category' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects category block without primary', () => {
      const result = ManifestSchema.safeParse({
        name: 'x',
        version: '1.0.0',
        description: 'd',
        type: 'skill',
        targets: ['claude-code'],
        category: { secondary: ['economy'] },
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown value in secondary array', () => {
      const result = ManifestSchema.safeParse({
        name: 'x',
        version: '1.0.0',
        description: 'd',
        type: 'skill',
        targets: ['claude-code'],
        category: { primary: 'tooling', secondary: ['nope'] },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('enable/disable globals targeting (v0.7)', () => {
    const baseOutfit = {
      name: 'p',
      version: '1.0.0',
      description: 'd',
      type: 'outfit' as const,
      targets: ['claude-code' as const],
      categories: [],
    };
    const baseMode = {
      name: 'm',
      version: '1.0.0',
      description: 'd',
      type: 'mode' as const,
      targets: ['claude-code' as const],
      categories: [],
    };
    const baseAccessory = {
      name: 'a',
      version: '1.0.0',
      description: 'd',
      type: 'accessory' as const,
      targets: ['claude-code' as const],
    };

    it('outfit parses with enable/disable blocks', () => {
      const r = OutfitSchema.safeParse({
        ...baseOutfit,
        enable: { plugins: ['x'], mcps: [], hooks: [] },
        disable: { plugins: [], mcps: ['y'], hooks: [] },
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.enable.plugins).toEqual(['x']);
        expect(r.data.disable.mcps).toEqual(['y']);
      }
    });

    it('outfit without enable/disable defaults to all-empty (back-compat)', () => {
      const r = OutfitSchema.safeParse(baseOutfit);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.enable).toEqual({ plugins: [], mcps: [], hooks: [] });
        expect(r.data.disable).toEqual({ plugins: [], mcps: [], hooks: [] });
      }
    });

    it('mode parses with enable/disable blocks', () => {
      const r = ModeSchema.safeParse({
        ...baseMode,
        disable: { plugins: ['noisy-plugin'], mcps: [], hooks: [] },
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.disable.plugins).toEqual(['noisy-plugin']);
        expect(r.data.enable.plugins).toEqual([]);
      }
    });

    it('accessory parses with enable block', () => {
      const r = AccessorySchema.safeParse({
        ...baseAccessory,
        enable: { plugins: ['axiom'], mcps: ['axiom-mcp'], hooks: [] },
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.enable.mcps).toEqual(['axiom-mcp']);
      }
    });

    it('rejects unknown keys inside enable block (strict)', () => {
      const r = OutfitSchema.safeParse({
        ...baseOutfit,
        enable: { plugins: [], mcps: [], hooks: [], junk: ['no'] },
      });
      expect(r.success).toBe(false);
    });

    it('v3 outfit (no enable/disable, no skill arrays) round-trips through ManifestSchema', () => {
      const r = ManifestSchema.safeParse({
        name: 'old',
        version: '1.0.0',
        description: 'legacy',
        type: 'outfit',
        targets: ['claude-code'],
        categories: ['tooling'],
      });
      expect(r.success).toBe(true);
    });
  });
});
