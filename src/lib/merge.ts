/**
 * Deep-merge utilities for the project-state mutator (`suit up`).
 *
 * Fragment files (e.g. `.claude/settings.fragment.json`, codex `hooks.json`,
 * `codex.config.toml`, `.mcp.fragment.json`) are designed to accumulate
 * per-component contributions — each hook contributes its own event entry,
 * each mcp component contributes its own server entry, an outfit may
 * contribute a permissions block, and so on. When `suit up` collects emit
 * output across a multi-component outfit, the same path appears twice with
 * different bytes.
 *
 * JSON and TOML files are merged structurally (arrays concat, objects deep-
 * merge by key). For non-mergeable files (markdown, scripts, lockfiles) the
 * up.ts dedupe still refuses on byte-mismatch — that's a real authoring bug.
 */

import TOML, { type JsonMap } from '@iarna/toml';

/**
 * Whether two emits at the same path can be merged. JSON and TOML files are
 * mergeable; everything else (markdown, scripts) must be byte-identical at
 * dedupe time or it's an authoring bug.
 */
export function isJsonMergeable(filepath: string): boolean {
  return filepath.endsWith('.json');
}

export function isTomlMergeable(filepath: string): boolean {
  return filepath.endsWith('.toml');
}

export function isMergeable(filepath: string): boolean {
  return isJsonMergeable(filepath) || isTomlMergeable(filepath);
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

/**
 * Deep-merge two TOML buffers and return the canonical-formatted result.
 * Same semantics as mergeJsonBuffers: arrays concat, objects deep-merge,
 * primitives last-write-wins. Used for `codex.config.toml` accumulation when
 * multiple components (e.g. mcp + outfit permissions) contribute to it.
 */
export function mergeTomlBuffers(a: Buffer | string, b: Buffer | string): Buffer {
  const parsedA = TOML.parse(toUtf8(a)) as Record<string, unknown>;
  const parsedB = TOML.parse(toUtf8(b)) as Record<string, unknown>;
  const merged = deepMerge(parsedA, parsedB) as JsonMap;
  return Buffer.from(TOML.stringify(merged), 'utf-8');
}

/**
 * Dispatch-by-extension wrapper. Returns null when the path is not mergeable
 * — callers should treat this as the "byte-mismatch is an authoring bug"
 * signal.
 */
export function mergeBuffers(
  filepath: string,
  a: Buffer | string,
  b: Buffer | string,
): Buffer | null {
  if (isJsonMergeable(filepath)) return mergeJsonBuffers(a, b);
  if (isTomlMergeable(filepath)) return mergeTomlBuffers(a, b);
  return null;
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
