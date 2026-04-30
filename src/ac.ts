#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAc } from './lib/ac/run';
import { listCommand, showCommand, doctorCommand } from './lib/ac/introspect';

const argv = process.argv.slice(2);
// SUIT_CONTENT_PATH overrides builtinDir so suit can read personas/modes/skills
// from an external content directory (e.g., agent-config) without bundling them.
const homeDirs = () => {
  const envContent = process.env.SUIT_CONTENT_PATH?.trim();
  return {
    projectDir: process.cwd(),
    userDir: path.join(os.homedir(), '.config', 'agent-config'),
    builtinDir: envContent
      ? path.resolve(envContent)
      : path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  };
};

async function main(): Promise<number> {
  if (argv[0] === 'list') {
    const what = argv[1];
    if (what !== 'personas' && what !== 'modes') {
      process.stderr.write('ac list: expected "personas" or "modes"\n');
      return 2;
    }
    await listCommand(what, { ...homeDirs(), print: (l) => process.stdout.write(l + '\n') });
    return 0;
  }
  if (argv[0] === 'show') {
    const kind = argv[1];
    if (kind !== 'persona' && kind !== 'mode' && kind !== 'effective') {
      process.stderr.write('ac show: expected "persona <name>" | "mode <name>" | "effective ..."\n');
      return 2;
    }
    const name = argv[2];
    await showCommand(
      { kind: kind as 'persona' | 'mode' | 'effective', name },
      { ...homeDirs(), print: (l) => process.stdout.write(l + '\n') },
    );
    return 0;
  }
  if (argv[0] === 'doctor') {
    return doctorCommand({
      harnesses: ['claude-code', 'apm', 'codex', 'gemini', 'copilot', 'pi'],
      print: (l) => process.stdout.write(l + '\n'),
    });
  }
  // Default: ac <harness> [flags] -- <harness args>
  return runAc(argv);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
