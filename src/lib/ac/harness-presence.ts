import { execSync } from 'node:child_process';

const HARNESS_BINS: Record<string, string> = {
  'claude-code': 'claude',
  apm: 'apm',
  codex: 'codex',
  gemini: 'gemini',
  copilot: 'copilot',
  pi: 'pi',
};

export interface HarnessPresence {
  harness: string;
  bin: string;
  found: boolean;
  binPath?: string;
}

export interface PresenceDeps {
  whichBin?: (bin: string) => string | null;
}

// POSIX. Windows callers must inject deps.whichBin.
function defaultWhich(bin: string): string | null {
  try {
    return (
      execSync(`command -v ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}

export function getHarnessPresence(
  harnesses: string[],
  deps: PresenceDeps = {},
): HarnessPresence[] {
  const which = deps.whichBin ?? defaultWhich;
  return harnesses.map((harness) => {
    // Unknown harnesses fall back to harness-name-as-bin; PATH lookup will
    // fail and surface as found:false rather than throw.
    const bin = HARNESS_BINS[harness] ?? harness;
    const binPath = which(bin);
    return {
      harness,
      bin,
      found: binPath !== null,
      binPath: binPath ?? undefined,
    };
  });
}
