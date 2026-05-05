import { existsSync } from 'node:fs';
import path from 'node:path';
import { openContentStore } from '../content-store.js';

export interface RunInitArgs {
  url: string;
  force: boolean;
  contentDir: string;
}

export interface RunInitDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export async function runInit(args: RunInitArgs, deps: RunInitDeps): Promise<number> {
  const store = openContentStore(args.contentDir);
  const result = await store.init(args.url, args.force);
  if (!result.ok) {
    deps.stderr(`${result.message}\n`);
    return 1;
  }
  deps.stdout(`${result.message}\n`);

  const hasOutfits = existsSync(path.join(args.contentDir, 'outfits'));
  const hasCuts = existsSync(path.join(args.contentDir, 'cuts'));
  if (!hasOutfits && !hasCuts) {
    deps.stderr(
      `Warning: cloned content has no outfits/ or cuts/ directories. ` +
        `This may not be a suit content repo.\n`,
    );
  }
  return 0;
}
