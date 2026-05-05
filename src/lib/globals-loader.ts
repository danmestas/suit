import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { GlobalsRegistrySchema, type GlobalsRegistry } from './globals-schema.js';

/**
 * Load and parse a `globals.yaml` from the wardrobe builtin tier.
 *
 * Returns `null` when the file doesn't exist (graceful fall-through during
 * the v0.7 migration window — the wardrobe may not yet carry one). Throws on
 * any other read or parse error so authoring mistakes surface loudly.
 *
 * The path convention is `<builtinDir>/globals.yaml`; the caller passes the
 * builtin dir resolved by `runUp`/launcher discovery.
 */
export async function loadGlobalsRegistry(
  builtinDir: string,
): Promise<GlobalsRegistry | null> {
  const filepath = path.join(builtinDir, 'globals.yaml');
  let raw: string;
  try {
    raw = await fs.readFile(filepath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = YAML.parse(raw);
  return GlobalsRegistrySchema.parse(parsed);
}
