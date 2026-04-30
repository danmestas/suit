#!/usr/bin/env node
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runAc } from './lib/ac/run.js';
import { listCommand, showCommand, doctorCommand } from './lib/ac/introspect.js';
import { runInit } from './lib/ac/init.js';
import { runSync } from './lib/ac/sync.js';
import { runStatus } from './lib/ac/status.js';
import { helpText } from './lib/ac/help.js';
import { resolveSuitPaths } from './lib/paths.js';
import { KNOWN_HARNESSES } from './lib/ac/harness-presence.js';

const argv = process.argv.slice(2);

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

function readTemplateUrl(): string | undefined {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const url = pkg.suit?.templateUrl;
    return typeof url === 'string' && url.length > 0 ? url : undefined;
  } catch {
    return undefined;
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
    const url = parsed.url ?? readTemplateUrl();
    if (url === undefined) {
      process.stderr.write('suit init: missing <url> argument and no `suit.templateUrl` configured\n');
      process.stderr.write('Usage: suit init [<url>] [--force]\n');
      return 2;
    }
    return runInit(
      { url, force: parsed.force, contentDir: paths.contentDir },
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
      { contentDir: paths.contentDir, version: readVersion(), harnesses: KNOWN_HARNESSES },
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
      harnesses: KNOWN_HARNESSES,
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
    // exit 1 = runtime error (thrown during execution); exit 2 = usage error (returned from main).
    // Anything that reaches the catch handler is by definition runtime.
    process.exit(1);
  },
);
