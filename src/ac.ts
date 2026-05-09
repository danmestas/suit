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
import { runPrepare } from './lib/ac/prepare.js';
import { helpText } from './lib/ac/help.js';
import { resolveSuitPaths } from './lib/paths.js';
import { KNOWN_HARNESSES } from './lib/ac/harness-presence.js';
import { TARGETS, type Target } from './lib/types.js';

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
  cut: string | null;
  accessories: string[];
  force: boolean;
  err: string | null;
}

/**
 * Parse `suit up` args. Surface the first parse error via `err` so the caller
 * can print it consistently with the rest of the CLI rather than throwing.
 *
 * Recognized flags: `--outfit X`, `--cut Y`, `--accessory A` (repeatable), `--force`.
 * The `=` form (`--outfit=X`) is also accepted for muscle-memory parity with
 * other CLIs.
 */
function parseUpArgs(rest: string[]): UpArgs {
  let outfit: string | null = null;
  let cut: string | null = null;
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
    } else if (flag === '--cut') {
      const r = takeValue(flag, i, eqValue);
      if (r.value === null) {
        err = err ?? 'suit up: --cut requires a value';
        continue;
      }
      cut = r.value;
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
  return { outfit, cut, accessories, force, err };
}

interface PrepareArgs {
  outfit: string | null;
  cut: string | null;
  accessories: string[];
  target: Target | null;
  quiet: boolean;
  dryRun: boolean;
  err: string | null;
}

/**
 * Short-form aliases accepted on `--target`. Internal type stays canonical
 * (`claude-code`); aliases are resolved at parse time so callers/wrappers
 * can write the harness binary's name (`claude`) without hand-mapping.
 */
const TARGET_ALIASES: Record<string, Target> = {
  claude: 'claude-code',
};

function resolveTargetArg(raw: string): Target | null {
  if (TARGET_ALIASES[raw]) return TARGET_ALIASES[raw];
  return TARGETS.includes(raw as Target) ? (raw as Target) : null;
}

/**
 * Parse `suit prepare` args. Same flag shape as `suit up`, plus `--target` to
 * scope the bundle to a single harness. Per ADR (#36), `prepare` is
 * single-target on the first cut — multi-target opens questions about
 * combined-prefix bundle layouts that don't have answers yet.
 *
 * Singleton flags (`--outfit`, `--cut`, `--target`, `--quiet`, `--dry-run`)
 * reject duplicates: `--outfit a --outfit b` errors rather than silently
 * taking the last value, which masked caller bugs in programmatic invocations.
 * `--accessory` is repeatable by design; same value passed twice is deduped
 * with a warning to stderr.
 */
function parsePrepareArgs(rest: string[]): PrepareArgs {
  let outfit: string | null = null;
  let cut: string | null = null;
  const accessories: string[] = [];
  const accessorySeen = new Set<string>();
  let target: Target | null = null;
  let quiet = false;
  let dryRun = false;
  let err: string | null = null;

  // Track which singleton flags have been seen so duplicates can be rejected
  // explicitly rather than silently last-wins. Repeatable flags
  // (`--accessory`) use a separate de-dup set above.
  const seenSingletons = new Set<string>();
  function rejectIfDuplicate(flag: string): boolean {
    if (seenSingletons.has(flag)) {
      err = err ?? `suit prepare: ${flag} passed multiple times`;
      return true;
    }
    seenSingletons.add(flag);
    return false;
  }

  function takeValue(_flag: string, i: number, eqValue: string | undefined): { value: string | null; next: number } {
    if (eqValue !== undefined) return { value: eqValue, next: i };
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('-')) {
      return { value: null, next: i };
    }
    return { value: next, next: i + 1 };
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    let flag = arg;
    let eqValue: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      flag = arg.slice(0, eq);
      eqValue = arg.slice(eq + 1);
    }
    if (flag === '--outfit') {
      if (rejectIfDuplicate(flag)) continue;
      const r = takeValue(flag, i, eqValue);
      if (r.value === null) { err = err ?? 'suit prepare: --outfit requires a value'; continue; }
      outfit = r.value;
      i = r.next;
    } else if (flag === '--cut') {
      if (rejectIfDuplicate(flag)) continue;
      const r = takeValue(flag, i, eqValue);
      if (r.value === null) { err = err ?? 'suit prepare: --cut requires a value'; continue; }
      cut = r.value;
      i = r.next;
    } else if (flag === '--accessory') {
      const r = takeValue(flag, i, eqValue);
      if (r.value === null) { err = err ?? 'suit prepare: --accessory requires a value'; continue; }
      if (accessorySeen.has(r.value)) {
        process.stderr.write(`suit prepare: --accessory ${r.value} passed multiple times; deduplicating\n`);
      } else {
        accessorySeen.add(r.value);
        accessories.push(r.value);
      }
      i = r.next;
    } else if (flag === '--target') {
      if (rejectIfDuplicate(flag)) continue;
      const r = takeValue(flag, i, eqValue);
      if (r.value === null) { err = err ?? 'suit prepare: --target requires a value'; continue; }
      const resolved = resolveTargetArg(r.value);
      if (resolved === null) {
        const knownAliases = Object.keys(TARGET_ALIASES).join(', ');
        err = err ?? `suit prepare: unknown --target "${r.value}" (known: ${TARGETS.join(', ')}; aliases: ${knownAliases})`;
        continue;
      }
      target = resolved;
      i = r.next;
    } else if (flag === '--quiet') {
      if (rejectIfDuplicate(flag)) continue;
      quiet = true;
    } else if (flag === '--dry-run') {
      if (rejectIfDuplicate(flag)) continue;
      dryRun = true;
    } else {
      err = err ?? `suit prepare: unrecognized argument "${arg}"`;
    }
  }
  return { outfit, cut, accessories, target, quiet, dryRun, err };
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
    if (what !== 'outfits' && what !== 'cuts' && what !== 'accessories') {
      process.stderr.write('suit list: expected "outfits", "cuts", or "accessories"\n');
      return 2;
    }
    const rest = argv.slice(2);
    let verbose = false;
    let resolvable = false;
    for (const a of rest) {
      if (a === '-v' || a === '--verbose') {
        verbose = true;
      } else if (a === '--resolvable' || a === '--include-fall-through') {
        // Only meaningful for `list accessories`; --resolvable on outfits/cuts
        // is silently ignored rather than rejected, to keep the flag surface
        // forgiving for tab-completion habits.
        resolvable = true;
      } else {
        process.stderr.write(`suit list: unrecognized argument "${a}"\n`);
        return 2;
      }
    }
    await listCommand(
      what,
      { ...dirs, print: (l) => process.stdout.write(l + '\n') },
      { verbose, resolvable },
    );
    return 0;
  }

  if (cmd === 'show') {
    const kind = argv[1];
    if (kind !== 'outfit' && kind !== 'cut' && kind !== 'accessory' && kind !== 'effective') {
      process.stderr.write(
        'suit show: expected "outfit <name>" | "cut <name>" | "accessory <name>" | "effective ..."\n',
      );
      return 2;
    }
    const name = argv[2];
    await showCommand(
      { kind: kind as 'outfit' | 'cut' | 'accessory' | 'effective', name },
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
        cut: parsed.cut,
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

  if (cmd === 'prepare') {
    const parsed = parsePrepareArgs(argv.slice(1));
    if (parsed.err) {
      process.stderr.write(`${parsed.err}\n`);
      return 2;
    }
    if (parsed.outfit === null) {
      process.stderr.write('suit prepare: --outfit is required\n');
      return 2;
    }
    if (parsed.target === null) {
      process.stderr.write(
        `suit prepare: --target is required (one of: ${TARGETS.join(', ')})\n`,
      );
      return 2;
    }
    return runPrepare(
      {
        outfit: parsed.outfit,
        cut: parsed.cut,
        accessories: parsed.accessories,
        target: parsed.target,
        projectDir: dirs.projectDir,
        contentDir: paths.contentDir,
        userDir: paths.userOverlayDir,
        quiet: parsed.quiet,
        dryRun: parsed.dryRun,
      },
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
