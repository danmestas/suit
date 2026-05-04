/**
 * JSON deep-merge utilities for the project-state mutator (`suit up`).
 *
 * Fragment files (e.g. `.claude/settings.fragment.json`, codex `hooks.json`,
 * `.mcp.fragment.json`) are designed to accumulate per-component contributions
 * — each hook contributes its own event entry, each mcp component contributes
 * its own server entry, and so on. When `suit up` collects emit output across
 * a multi-hook outfit, the same path appears twice with different bytes.
 *
 * For non-mergeable files (markdown, scripts, lockfiles) the up.ts dedupe
 * still refuses on byte-mismatch — that's a real authoring bug.
 */

/**
 * Whether two emits at the same path can be merged. Today this is "any JSON
 * file." If a future fragment is ever non-JSON we'd narrow this to a known
 * suffix list, but every fragment-style emit suit produces today is JSON.
 */
export function isJsonMergeable(filepath: string): boolean {
  return filepath.endsWith('.json');
}

/**
 * Deep-merge two JSON buffers and return the canonical-formatted result.
 *
 * - Arrays concatenate (preserves all hook entries, all mcp servers, etc.).
 * - Objects merge by key; recursive when both sides are objects.
 * - Primitives: second value wins (last write).
 *
 * Round-trips through JSON.stringify(..., 2) so the on-disk shape stays
 * consistent with what the adapters emit when they format a fresh fragment.
 */
export function mergeJsonBuffers(a: Buffer | string, b: Buffer | string): Buffer {
  const parsedA = JSON.parse(toUtf8(a));
  const parsedB = JSON.parse(toUtf8(b));
  const merged = deepMerge(parsedA, parsedB);
  return Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
}

function toUtf8(buf: Buffer | string): string {
  return typeof buf === 'string' ? buf : buf.toString('utf-8');
}

export function deepMerge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (
    typeof a === 'object' && a !== null && !Array.isArray(a) &&
    typeof b === 'object' && b !== null && !Array.isArray(b)
  ) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
      out[k] = k in (a as Record<string, unknown>)
        ? deepMerge((a as Record<string, unknown>)[k], v)
        : v;
    }
    return out;
  }
  return b;
}
