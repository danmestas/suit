import { openContentStore } from '../content-store';

export interface RunSyncArgs {
  contentDir: string;
}

export interface RunSyncDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export async function runSync(args: RunSyncArgs, deps: RunSyncDeps): Promise<number> {
  const store = openContentStore(args.contentDir);
  const result = await store.sync();
  if (!result.ok) {
    deps.stderr(`${result.message}\n`);
    return 1;
  }
  deps.stdout(`${result.message}\n`);
  return 0;
}
