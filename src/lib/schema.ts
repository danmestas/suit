import { z } from 'zod';
import { COMPONENT_TYPES, TARGETS, type ComponentType, type Target } from './types.js';

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const CATEGORIES = [
  'economy',
  'workflow',
  'backpressure',
  'tooling',
  'integrations',
  'context-management',
  'memory-management',
  'evolution',
] as const;
export type Category = typeof CATEGORIES[number];

const CategoryBlock = z
  .object({
    primary: z.enum(CATEGORIES as unknown as [Category, ...Category[]]),
    secondary: z
      .array(z.enum(CATEGORIES as unknown as [Category, ...Category[]]))
      .optional(),
  })
  .strict();

const HookEntry = z.object({
  command: z.string().min(1),
  matcher: z.string().optional(),
});

const AgentBlock = z.object({
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  color: z.string().optional(),
});

const MCPBlock = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

// License is either a SPDX-style string (e.g., "MIT") or an attribution block
// for upstream-sourced components carrying provenance metadata.
const LicenseAttribution = z
  .object({
    upstream: z.string().min(1),
    source: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();
const LicenseField = z.union([z.string(), LicenseAttribution]);

const ManifestBaseSchema = z
  .object({
    name: z.string().regex(NAME_RE, 'name must be kebab-case lowercase'),
    version: z.string().regex(SEMVER_RE, 'version must be valid semver'),
    description: z.string().min(1),
    category: CategoryBlock.optional(),
    type: z.enum(['skill', 'plugin', 'hook', 'agent', 'rules', 'mcp'] as const),
    // (outfit / mode / accessory carry their own narrowed `type` literal in
    // their respective extended schemas — they are not in the base list.)
    targets: z.array(z.enum(TARGETS as unknown as [Target, ...Target[]])).min(1),
    author: z.string().optional(),
    license: LicenseField.optional(),
    tags: z.array(z.string()).optional(),
    hooks: z.record(HookEntry).optional(),
    agent: AgentBlock.optional(),
    mcp: MCPBlock.optional(),
    includes: z.array(z.string()).optional(),
    scope: z.enum(['project', 'user']).optional(),
    before: z.array(z.string()).optional(),
    after: z.array(z.string()).optional(),
    overrides: z
      .record(
        z.enum(TARGETS as unknown as [Target, ...Target[]]),
        z.record(z.unknown()),
      )
      .optional(),
  })
  .strict();

// Reusable include-block sub-schema. Both ModeSchema and AccessorySchema embed
// this same shape so a Phase 3 mode can declare structured component bundles
// alongside (or instead of) its body-only prompt overlay. Defaults to all-empty
// arrays so authors only need to declare keys they care about.
const IncludeBlockSchema = z
  .object({
    skills: z.array(z.string()).default([]),
    rules: z.array(z.string()).default([]),
    hooks: z.array(z.string()).default([]),
    agents: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
  })
  .strict()
  .default({ skills: [], rules: [], hooks: [], agents: [], commands: [] });

// v0.7+: globals targeting block. Outfits, modes, and accessories may declare
// `enable:` / `disable:` blocks naming user-scope plugins, MCP servers, and
// hooks (registered in `globals.yaml`). The resolver layers these per-CLI
// declaration order to derive a kept-set; the symlink-farm filters per-subdir
// against that set so user-scope globals can be selectively turned off without
// uninstalling them. Defaults to all-empty so v3 manifests round-trip unchanged.
const EnableDisableBlockSchema = z
  .object({
    plugins: z.array(z.string()).default([]),
    mcps: z.array(z.string()).default([]),
    hooks: z.array(z.string()).default([]),
  })
  .strict()
  .default({ plugins: [], mcps: [], hooks: [] });

export type EnableDisableBlock = z.infer<typeof EnableDisableBlockSchema>;

export const OutfitSchema = ManifestBaseSchema.extend({
  type: z.literal('outfit'),
  categories: z.array(z.string()).min(0),
  skill_include: z.array(z.string()).default([]),
  skill_exclude: z.array(z.string()).default([]),
  enable: EnableDisableBlockSchema,
  disable: EnableDisableBlockSchema,
}).strict();

export type OutfitManifest = z.infer<typeof OutfitSchema>;

export const ModeSchema = ManifestBaseSchema.extend({
  type: z.literal('mode'),
  categories: z.array(z.string()).min(0),
  skill_include: z.array(z.string()).default([]),
  skill_exclude: z.array(z.string()).default([]),
  // Optional Phase 3 structured include block. Body-only modes (the v0.3 shape)
  // continue to work — `include` defaults to all-empty arrays, and the
  // resolver's force-include phase becomes a no-op when every sub-array is empty.
  include: IncludeBlockSchema,
  enable: EnableDisableBlockSchema,
  disable: EnableDisableBlockSchema,
}).strict();

export type ModeManifest = z.infer<typeof ModeSchema>;

export const AccessorySchema = ManifestBaseSchema.extend({
  type: z.literal('accessory'),
  include: IncludeBlockSchema,
  enable: EnableDisableBlockSchema,
  disable: EnableDisableBlockSchema,
}).strict();

export type AccessoryManifest = z.infer<typeof AccessorySchema>;

export const ManifestSchema = z.discriminatedUnion('type', [
  ManifestBaseSchema,
  OutfitSchema,
  ModeSchema,
  AccessorySchema,
]);

export type Manifest = z.infer<typeof ManifestSchema>;
