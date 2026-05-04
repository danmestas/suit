import { openContentStore } from '../content-store.js';
import { getHarnessPresence } from './harness-presence.js';

export interface RunStatusArgs {
  contentDir: string;
  version: string;
  harnesses: string[];
}

export interface RunStatusDeps {
  stdout: (s: string) => void;
  whichBin?: (bin: string) => string | null;
}

export async function runStatus(args: RunStatusArgs, deps: RunStatusDeps): Promise<number> {
  const lines: string[] = [];
  lines.push(`suit     v${args.version}`);

  // status() can throw on corrupted git config / fs errors; degrade gracefully.
  const store = openContentStore(args.contentDir);
  try {
    // checkRemote=true does a best-effort `git fetch` to compute upstream
    // divergence. Bounded by GIT_HTTP_LOW_SPEED_TIME inside the store; if
    // offline or anything goes wrong, sync is undefined and we skip the
    // staleness line.
    const status = await store.status({ checkRemote: true });
    if (!status.exists) {
      lines.push(`Content: (none — run \`suit init <url>\`)`);
    } else if (!status.isGitRepo) {
      lines.push(`Content: ${args.contentDir} (not a git repo)`);
    } else {
      const remote = status.remote ?? '(no origin)';
      lines.push(`Content: ${args.contentDir} (clone of ${remote})`);

      // Surface staleness when behind the upstream — happy path stays quiet.
      if (status.sync && status.sync.behind > 0) {
        const upstream = status.sync.upstream ?? 'origin';
        const n = status.sync.behind;
        lines.push(
          `Wardrobe: ${n} commit${n === 1 ? '' : 's'} behind ${upstream} (run \`suit sync\` to update)`,
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lines.push(`Content: ${args.contentDir} (error: ${message})`);
  }

  if (args.harnesses.length > 0) {
    const presence = getHarnessPresence(args.harnesses, { whichBin: deps.whichBin });
    const summary = presence
      .map((p) => `${p.harness} ${p.found ? '✓' : '✗'}`)
      .join('  ');
    lines.push(`Harness: ${summary}`);
  }

  for (const line of lines) deps.stdout(line + '\n');
  return 0;
}
