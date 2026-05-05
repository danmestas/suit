import { listAllOutfits, findOutfit, type DiscoveryDirs } from '../outfit.js';
import { listAllCuts, findCut } from '../cut.js';
import { listAllAccessories, findAccessory } from '../accessory.js';
import { getHarnessPresence } from './harness-presence.js';
import { extractBlurb } from '../blurb.js';

export interface IntrospectDeps extends DiscoveryDirs {
  print: (line: string) => void;
}

export interface ListOptions {
  /** When true, print a blurb sub-line under each row. */
  verbose?: boolean;
}

export async function listCommand(
  what: 'outfits' | 'cuts' | 'accessories',
  deps: IntrospectDeps,
  opts: ListOptions = {},
): Promise<void> {
  const verbose = opts.verbose === true;
  // Sub-line indent: width of `${name20} v${version8} [${source}]  ` ≈ 20+1+8+...
  // Use a stable 4-space indent — keeps wrapping simple and matches `-v` output
  // across narrow terminals.
  const indent = '    ';

  if (what === 'outfits') {
    const all = await listAllOutfits(deps);
    if (all.length === 0) {
      deps.print('(no outfits found)');
      return;
    }
    for (const p of all) {
      deps.print(`${p.manifest.name.padEnd(20)} v${p.manifest.version.padEnd(8)} [${p.source}]  ${p.manifest.description}`);
      if (verbose) {
        const blurb = extractBlurb(p.body, p.manifest.description);
        if (blurb !== p.manifest.description) deps.print(`${indent}${blurb}`);
      }
    }
    return;
  }
  if (what === 'cuts') {
    const all = await listAllCuts(deps);
    if (all.length === 0) {
      deps.print('(no cuts found)');
      return;
    }
    for (const m of all) {
      deps.print(`${m.manifest.name.padEnd(20)} v${m.manifest.version.padEnd(8)} [${m.source}]  ${m.manifest.description}`);
      if (verbose) {
        const blurb = extractBlurb(m.body, m.manifest.description);
        if (blurb !== m.manifest.description) deps.print(`${indent}${blurb}`);
      }
    }
    return;
  }
  // accessories
  const all = await listAllAccessories(deps);
  if (all.length === 0) {
    deps.print('(no accessories found)');
    return;
  }
  for (const a of all) {
    deps.print(`${a.manifest.name.padEnd(20)} v${a.manifest.version.padEnd(8)} [${a.source}]  ${a.manifest.description}`);
    if (verbose) {
      const blurb = extractBlurb(a.body, a.manifest.description);
      if (blurb !== a.manifest.description) deps.print(`${indent}${blurb}`);
    }
  }
}

export interface ShowOptions {
  kind: 'outfit' | 'cut' | 'accessory' | 'effective';
  name?: string;
  outfit?: string;
  cut?: string;
}

export async function showCommand(
  opts: ShowOptions,
  deps: IntrospectDeps,
): Promise<void> {
  if (opts.kind === 'outfit') {
    if (!opts.name) throw new Error('ac show outfit <name>: name required');
    const f = await findOutfit(opts.name, deps);
    deps.print(`name: ${f.manifest.name}`);
    deps.print(`version: ${f.manifest.version}`);
    deps.print(`source: ${f.source} (${f.filepath})`);
    deps.print(`description: ${f.manifest.description}`);
    deps.print(`targets: ${f.manifest.targets.join(', ')}`);
    deps.print(`categories: ${f.manifest.categories.join(', ')}`);
    deps.print(`skill_include: ${(f.manifest.skill_include ?? []).join(', ')}`);
    deps.print(`skill_exclude: ${(f.manifest.skill_exclude ?? []).join(', ')}`);
    if (f.body.trim()) {
      deps.print('');
      deps.print('--- body ---');
      deps.print(f.body.trim());
    }
    return;
  }
  if (opts.kind === 'cut') {
    if (!opts.name) throw new Error('ac show cut <name>: name required');
    const f = await findCut(opts.name, deps);
    deps.print(`name: ${f.manifest.name}`);
    deps.print(`version: ${f.manifest.version}`);
    deps.print(`source: ${f.source} (${f.filepath})`);
    deps.print(`description: ${f.manifest.description}`);
    deps.print(`targets: ${f.manifest.targets.join(', ')}`);
    deps.print(`categories: ${f.manifest.categories.join(', ')}`);
    deps.print(`skill_include: ${(f.manifest.skill_include ?? []).join(', ')}`);
    deps.print(`skill_exclude: ${(f.manifest.skill_exclude ?? []).join(', ')}`);
    // Print the structured `include:` block when the cut declares one
    // (any non-empty sub-array). Body-only cuts — the v0.3-era mode default —
    // have all five sub-arrays empty and we omit the section entirely so their
    // `show` output is unchanged.
    const inc = f.manifest.include;
    const hasIncludes =
      inc.skills.length +
        inc.rules.length +
        inc.hooks.length +
        inc.agents.length +
        inc.commands.length >
      0;
    if (hasIncludes) {
      deps.print('include:');
      deps.print(`  skills: ${inc.skills.join(', ')}`);
      deps.print(`  rules: ${inc.rules.join(', ')}`);
      deps.print(`  hooks: ${inc.hooks.join(', ')}`);
      deps.print(`  agents: ${inc.agents.join(', ')}`);
      deps.print(`  commands: ${inc.commands.join(', ')}`);
    }
    deps.print('');
    deps.print('--- cut prompt body (injected as additional context when active) ---');
    deps.print(f.body.trim());
    return;
  }
  if (opts.kind === 'accessory') {
    if (!opts.name) throw new Error('ac show accessory <name>: name required');
    const f = await findAccessory(opts.name, deps);
    deps.print(`name: ${f.manifest.name}`);
    deps.print(`version: ${f.manifest.version}`);
    deps.print(`source: ${f.source} (${f.filepath})`);
    deps.print(`description: ${f.manifest.description}`);
    deps.print(`targets: ${f.manifest.targets.join(', ')}`);
    deps.print('include:');
    deps.print(`  skills: ${f.manifest.include.skills.join(', ')}`);
    deps.print(`  rules: ${f.manifest.include.rules.join(', ')}`);
    deps.print(`  hooks: ${f.manifest.include.hooks.join(', ')}`);
    deps.print(`  agents: ${f.manifest.include.agents.join(', ')}`);
    deps.print(`  commands: ${f.manifest.include.commands.join(', ')}`);
    if (f.body.trim()) {
      deps.print('');
      deps.print('--- body ---');
      deps.print(f.body.trim());
    }
    return;
  }
  // 'effective' is wired in the run.ts flow path; printed here.
  throw new Error('ac show effective: not yet implemented');
}

export interface DoctorDeps {
  /** List of harnesses to check */
  harnesses: string[];
  print: (line: string) => void;
}

export async function doctorCommand(deps: DoctorDeps): Promise<number> {
  const presence = getHarnessPresence(deps.harnesses);
  let allFound = true;
  for (const entry of presence) {
    const status = entry.found ? '✓' : '✗';
    deps.print(`${status} ${entry.harness}${entry.binPath ? ` (${entry.binPath})` : ''}`);
    if (!entry.found) allFound = false;
  }
  return allFound ? 0 : 1;
}
