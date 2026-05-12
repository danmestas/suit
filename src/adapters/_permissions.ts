import type { Target, PermissionsBlock } from '../lib/types.js';
import { deepMerge } from '../lib/merge.js';

/**
 * Deep-merge an outfit's per-target permissions sub-block into a destination
 * config object. Returns the destination unchanged when the block (or the
 * target's sub-block) is absent, so callers can apply this unconditionally
 * during emit. Pure: the input destination is not mutated.
 *
 * Used by each adapter to honor the outfit's `permissions:` frontmatter
 * against its own native config target (Claude settings fragment, Codex TOML,
 * Gemini settings fragment, Pi permissions.json).
 */
export function applyPassthroughPermissions(
  permissions: PermissionsBlock | undefined,
  target: Target,
  destination: Record<string, unknown>,
): Record<string, unknown> {
  const block = permissions?.[target];
  if (!block || Object.keys(block).length === 0) return destination;
  return deepMerge(destination, block) as Record<string, unknown>;
}
