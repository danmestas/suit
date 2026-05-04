/**
 * Interactive picker for `suit up` (Phase D of v0.5; ADR-0012).
 *
 * Prompts the user to pick an outfit (required), a mode (optional, blank skips),
 * and accessories (optional, multi-select via comma-separated numbers, blank
 * skips). Uses Node's built-in readline — no new dependency.
 *
 * Only reachable when stdin AND stdout are both TTYs. Non-TTY callers should
 * not invoke `runPicker` — callers gate on `process.stdin.isTTY`.
 *
 * The picker reads only what's available in the resolved discovery chain
 * (project overlay → user overlay → builtin), reusing `listAllOutfits`,
 * `listAllModes`, `listAllAccessories` so the user sees exactly what
 * `suit list <kind>` would show.
 */
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { listAllOutfits } from '../outfit.js';
import { listAllModes } from '../mode.js';
import { listAllAccessories } from '../accessory.js';
import { extractBlurb } from '../blurb.js';

export interface PickerDirs {
  projectDir: string;
  userDir: string;
  builtinDir: string;
}

export interface PickerResult {
  outfit: string;
  mode: string | null;
  accessories: string[];
}

export interface PickerDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

/**
 * Drive the interactive picker. Returns the user's selection.
 *
 * Throws if the user picks an invalid number or aborts (Ctrl-C closes the
 * readline interface — caller should treat the rejected promise as exit code 1).
 */
export async function runPicker(
  dirs: PickerDirs,
  deps: PickerDeps,
): Promise<PickerResult> {
  const rl = readline.createInterface({ input, output });
  try {
    const outfits = await listAllOutfits(dirs);
    const modes = await listAllModes(dirs);
    const accessories = await listAllAccessories(dirs);

    if (outfits.length === 0) {
      throw new Error(
        'no outfits found in the wardrobe. Run `suit list outfits` to inspect, or check SUIT_CONTENT_PATH.',
      );
    }

    // --- Outfit (required) ---
    deps.stdout('Outfit:       (pick one)\n');
    for (let i = 0; i < outfits.length; i++) {
      const o = outfits[i]!;
      deps.stdout(`  ${i + 1}. ${o.manifest.name.padEnd(14)} ${o.manifest.description}\n`);
      const blurb = extractBlurb(o.body, o.manifest.description);
      if (blurb !== o.manifest.description) {
        deps.stdout(`     ${' '.repeat(14)} ${blurb}\n`);
      }
    }
    const outfitChoice = await prompt(rl, '> ');
    const outfitIdx = parseChoice(outfitChoice, outfits.length);
    if (outfitIdx === null) {
      throw new Error(`outfit: invalid selection "${outfitChoice}" (expected 1-${outfits.length})`);
    }
    const outfit = outfits[outfitIdx]!.manifest.name;

    // --- Mode (optional) ---
    let mode: string | null = null;
    if (modes.length > 0) {
      deps.stdout('\nMode:         (pick one, or empty to skip)\n');
      for (let i = 0; i < modes.length; i++) {
        const m = modes[i]!;
        deps.stdout(`  ${i + 1}. ${m.manifest.name.padEnd(14)} ${m.manifest.description}\n`);
        const blurb = extractBlurb(m.body, m.manifest.description);
        if (blurb !== m.manifest.description) {
          deps.stdout(`     ${' '.repeat(14)} ${blurb}\n`);
        }
      }
      const modeChoice = (await prompt(rl, '> ')).trim();
      if (modeChoice !== '') {
        const modeIdx = parseChoice(modeChoice, modes.length);
        if (modeIdx === null) {
          throw new Error(`mode: invalid selection "${modeChoice}" (expected 1-${modes.length} or empty)`);
        }
        mode = modes[modeIdx]!.manifest.name;
      }
    }

    // --- Accessories (optional, multi-select) ---
    const selectedAccessories: string[] = [];
    deps.stdout('\nAccessories:  (pick multiple by number, comma-separated; empty to skip)\n');
    if (accessories.length === 0) {
      deps.stdout('  (none yet defined in this wardrobe)\n');
    } else {
      for (let i = 0; i < accessories.length; i++) {
        const a = accessories[i]!;
        deps.stdout(`  ${i + 1}. ${a.manifest.name.padEnd(14)} ${a.manifest.description}\n`);
        const blurb = extractBlurb(a.body, a.manifest.description);
        if (blurb !== a.manifest.description) {
          deps.stdout(`     ${' '.repeat(14)} ${blurb}\n`);
        }
      }
    }
    const accChoice = (await prompt(rl, '> ')).trim();
    if (accChoice !== '' && accessories.length > 0) {
      const indices = accChoice.split(',').map((s) => s.trim()).filter((s) => s !== '');
      for (const i of indices) {
        const idx = parseChoice(i, accessories.length);
        if (idx === null) {
          throw new Error(`accessories: invalid selection "${i}" (expected 1-${accessories.length})`);
        }
        const name = accessories[idx]!.manifest.name;
        if (!selectedAccessories.includes(name)) selectedAccessories.push(name);
      }
    }

    deps.stdout('\n');
    return { outfit, mode, accessories: selectedAccessories };
  } finally {
    rl.close();
  }
}

function prompt(rl: readline.Interface, q: string): Promise<string> {
  return rl.question(q);
}

/**
 * Parse a 1-based string index against an array length. Returns the 0-based
 * index, or null if invalid (NaN, out of range, negative).
 */
function parseChoice(s: string, length: number): number | null {
  const n = Number.parseInt(s.trim(), 10);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > length) return null;
  return n - 1;
}
