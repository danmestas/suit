import { listAllOutfits, findOutfit, type DiscoveryDirs } from '../outfit.js';
import { listAllModes, findMode } from '../mode.js';
import { listAllAccessories, findAccessory } from '../accessory.js';
import { getHarnessPresence } from './harness-presence.js';

export interface IntrospectDeps extends DiscoveryDirs {
  print: (line: string) => void;
}

export async function listCommand(
  what: 'outfits' | 'modes' | 'accessories',
  deps: IntrospectDeps,
): Promise<void> {
  if (what === 'outfits') {
    const all = await listAllOutfits(deps);
    if (all.length === 0) {
      deps.print('(no outfits found)');
      return;
    }
    for (const p of all) {
      deps.print(`${p.manifest.name.padEnd(20)} v${p.manifest.version.padEnd(8)} [${p.source}]  ${p.manifest.description}`);
    }
    return;
  }
  if (what === 'modes') {
    const all = await listAllModes(deps);
    if (all.length === 0) {
      deps.print('(no modes found)');
      return;
    }
    for (const m of all) {
      deps.print(`${m.manifest.name.padEnd(20)} v${m.manifest.version.padEnd(8)} [${m.source}]  ${m.manifest.description}`);
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
  }
}

export interface ShowOptions {
  kind: 'outfit' | 'mode' | 'accessory' | 'effective';
  name?: string;
  outfit?: string;
  mode?: string;
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
  if (opts.kind === 'mode') {
    if (!opts.name) throw new Error('ac show mode <name>: name required');
    const f = await findMode(opts.name, deps);
    deps.print(`name: ${f.manifest.name}`);
    deps.print(`version: ${f.manifest.version}`);
    deps.print(`source: ${f.source} (${f.filepath})`);
    deps.print(`description: ${f.manifest.description}`);
    deps.print(`targets: ${f.manifest.targets.join(', ')}`);
    deps.print(`categories: ${f.manifest.categories.join(', ')}`);
    deps.print(`skill_include: ${(f.manifest.skill_include ?? []).join(', ')}`);
    deps.print(`skill_exclude: ${(f.manifest.skill_exclude ?? []).join(', ')}`);
    deps.print('');
    deps.print('--- mode prompt body (injected as additional context when active) ---');
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
