#!/usr/bin/env node
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runAc } from './lib/ac/run.js';
import { listCommand, showCommand, doctorCommand } from './lib/ac/introspect.js';
import { runInit } from './lib/ac/init.js';
import { runSync } from './lib/ac/sync.js';
import { runStatus } from './lib/ac/status.js';
import { runUp } from './lib/ac/up.js';
import { runOff } from './lib/ac/off.js';
import { runCurrent } from './lib/ac/current.js';
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
  const paths = resolveSuitPaths();
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

interface UpArgs {
  outfit: string | null;
  mode: string | null;
  accessories: string[];
  force: boolean;
  err: string | null;
}

/**
 * Parse `suit up` args. Surface the first parse error via `err` so the caller
 * can print it consistently with the rest of the CLI rather than throwing.
 *
 * Recognized flags: `--outfit X`, `--mode Y`, `--accessory A` (repeatable), `--force`.
 * The `=` form (`--outfit=X`) is also accepted for muscle-memory parity with
 * other CLIs.
 */
function parseUpArgs(rest: string[]): UpArgs {
  let outfit: string | null = null;
  let mode: string | null = null;
  const accessories: string[] = [];
  let force = false;
  let err: string | null = null;

  function takeValue(flag: string, i: number, eqValue: string | undefined): { value: string | null; next: number } {
    if (eqValue !== undefined) return { value: eqValue, next: i };
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('-')) {
      return { value: null, next: i };
    }
    return { value: next, next: i + 1 };
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--force') {
      force = true;
      continue;
    }
    let flag = arg;
    let eqValue: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      flag = arg.slice(0, eq);
      eqValue = arg.slice(eq + 1);
    }
    if (flag === '--outfit') {
      const r = takeValue(flag, i, eqValue);
      if (r.value === null) {
        err = err ?? 'suit up: --outfit requires a value';
        continue;
      }
      outfit = r.value;
      i = r.next;
    } else if (flag === '--mode') {
      const r = takeValue(flag, i, eqValue);
      if (r.value === null) {
        err = err ?? 'suit up: --mode requires a value';
        continue;
      }
      mode = r.value;
      i = r.next;
    } else if (flag === '--accessory') {
      const r = takeValue(flag, i, eqValue);
      if (r.value === null) {
        err = err ?? 'suit up: --accessory requires a value';
        continue;
      }
      accessories.push(r.value);
      i = r.next;
    } else {
      err = err ?? `suit up: unrecognized argument "${arg}"`;
    }
  }
  return { outfit, mode, accessories, force, err };
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
    if (what !== 'outfits' && what !== 'modes' && what !== 'accessories') {
      process.stderr.write('suit list: expected "outfits", "modes", or "accessories"\n');
      return 2;
    }
    await listCommand(what, { ...dirs, print: (l) => process.stdout.write(l + '\n') });
    return 0;
  }

  if (cmd === 'show') {
    const kind = argv[1];
    if (kind !== 'outfit' && kind !== 'mode' && kind !== 'accessory' && kind !== 'effective') {
      process.stderr.write(
        'suit show: expected "outfit <name>" | "mode <name>" | "accessory <name>" | "effective ..."\n',
      );
      return 2;
    }
    const name = argv[2];
    await showCommand(
      { kind: kind as 'outfit' | 'mode' | 'accessory' | 'effective', name },
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

  if (cmd === 'up') {
    const parsed = parseUpArgs(argv.slice(1));
    if (parsed.err) {
      process.stderr.write(`${parsed.err}\n`);
      return 2;
    }
    return runUp(
      {
        outfit: parsed.outfit,
        mode: parsed.mode,
        accessories: parsed.accessories,
        force: parsed.force,
        projectDir: dirs.projectDir,
        contentDir: paths.contentDir,
        userDir: paths.userOverlayDir,
        isTTY: process.stdin.isTTY === true,
      },
      {
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
      },
    );
  }

  if (cmd === 'current') {
    return runCurrent(
      { projectDir: dirs.projectDir },
      {
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
      },
    );
  }

  if (cmd === 'off') {
    const rest = argv.slice(1);
    let force = false;
    let err: string | null = null;
    for (const a of rest) {
      if (a === '--force') {
        force = true;
      } else {
        err = err ?? `suit off: unrecognized argument "${a}"`;
      }
    }
    if (err) {
      process.stderr.write(`${err}\n`);
      return 2;
    }
    return runOff(
      { projectDir: dirs.projectDir, force },
      {
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
      },
    );
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
