#!/usr/bin/env node
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runAc } from './lib/ac/run';
import { listCommand, showCommand, doctorCommand } from './lib/ac/introspect';
import { runInit } from './lib/ac/init';
import { runSync } from './lib/ac/sync';
import { runStatus } from './lib/ac/status';
import { helpText } from './lib/ac/help';
import { resolveSuitPaths } from './lib/paths';

const argv = process.argv.slice(2);
const HARNESSES = ['claude-code', 'apm', 'codex', 'gemini', 'copilot', 'pi'];

function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveSuitDirs() {
  const { paths, warnings } = resolveSuitPaths();
  for (const w of warnings) process.stderr.write(`${w}\n`);
  return {
    paths,
    dirs: {
      projectDir: process.cwd(),
      userDir: paths.userOverlayDir,
      builtinDir: paths.contentDir,
    },
  };
}

function parseInitArgs(rest: string[]): { url: string | null; force: boolean } {
  let url: string | null = null;
  let force = false;
  for (const a of rest) {
    if (a === '--force') force = true;
    else if (!a.startsWith('-') && url === null) url = a;
  }
  return { url, force };
}

async function main(): Promise<number> {
  const { paths, dirs } = resolveSuitDirs();
  const cmd = argv[0];

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(helpText());
    return 0;
  }

  if (cmd === 'init') {
    const parsed = parseInitArgs(argv.slice(1));
    if (parsed.url === null) {
      process.stderr.write('suit init: missing <url> argument\n');
      process.stderr.write('Usage: suit init <url> [--force]\n');
      return 2;
    }
    return runInit(
      { url: parsed.url, force: parsed.force, contentDir: paths.contentDir },
      {
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
      },
    );
  }

  if (cmd === 'sync') {
    return runSync(
      { contentDir: paths.contentDir },
      {
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
      },
    );
  }

  if (cmd === 'status' || cmd === undefined) {
    return runStatus(
      { contentDir: paths.contentDir, version: readVersion(), harnesses: HARNESSES },
      { stdout: (s) => process.stdout.write(s) },
    );
  }

  if (cmd === 'list') {
    const what = argv[1];
    if (what !== 'personas' && what !== 'modes') {
      process.stderr.write('suit list: expected "personas" or "modes"\n');
      return 2;
    }
    await listCommand(what, { ...dirs, print: (l) => process.stdout.write(l + '\n') });
    return 0;
  }

  if (cmd === 'show') {
    const kind = argv[1];
    if (kind !== 'persona' && kind !== 'mode' && kind !== 'effective') {
      process.stderr.write('suit show: expected "persona <name>" | "mode <name>" | "effective ..."\n');
      return 2;
    }
    const name = argv[2];
    await showCommand(
      { kind: kind as 'persona' | 'mode' | 'effective', name },
      { ...dirs, print: (l) => process.stdout.write(l + '\n') },
    );
    return 0;
  }

  if (cmd === 'doctor') {
    return doctorCommand({
      harnesses: HARNESSES,
      print: (l) => process.stdout.write(l + '\n'),
    });
  }

  // Default: suit <harness> ...
  return runAc(argv, dirs);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
