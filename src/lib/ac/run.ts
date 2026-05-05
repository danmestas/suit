import { runAcSession, type AcSessionDeps } from './session.js';

export interface ParsedAcArgs {
  harness: string;
  outfit?: string;
  cut?: string;
  /**
   * Names of accessories the user passed via repeated `--accessory <name>`
   * flags. Always present (default empty array) so callers can iterate without
   * a presence check. Order matches CLI order — the resolver applies
   * accessories left-to-right.
   */
  accessories: string[];
  noFilter: boolean;
  verbose: boolean;
  harnessArgs: string[];
}

/** Backwards-compatible alias for callers that import `RunDeps`. */
export type RunDeps = AcSessionDeps;

export function parseAcArgs(argv: string[]): ParsedAcArgs {
  if (argv.length === 0 || argv[0]!.startsWith('--')) {
    throw new Error('ac: missing harness name. Usage: ac <harness> [flags] -- <harness args>');
  }
  const out: ParsedAcArgs = {
    harness: argv[0]!,
    accessories: [],
    noFilter: false,
    verbose: false,
    harnessArgs: [],
  };
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (tok === '--') {
      out.harnessArgs = argv.slice(i + 1);
      return out;
    }
    if (tok === '--outfit') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error('ac: --outfit requires a value');
      }
      out.outfit = v;
      i += 2;
      continue;
    }
    if (tok === '--cut') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error('ac: --cut requires a value');
      }
      out.cut = v;
      i += 2;
      continue;
    }
    if (tok === '--accessory') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error('ac: --accessory requires a value');
      }
      out.accessories.push(v);
      i += 2;
      continue;
    }
    if (tok === '--no-filter') {
      out.noFilter = true;
      i += 1;
      continue;
    }
    if (tok === '--verbose') {
      out.verbose = true;
      i += 1;
      continue;
    }
    throw new Error(`ac: unrecognized flag "${tok}". (ac flags must come before "--")`);
  }
  return out;
}

/**
 * CLI entry point: parse argv and hand off to the AC session orchestrator.
 * Kept as a separate export so existing tests and the `ac` shebang script
 * keep working unchanged.
 */
export async function runAc(argv: string[], deps: RunDeps = {}): Promise<number> {
  const args = parseAcArgs(argv);
  return runAcSession(args, deps);
}
