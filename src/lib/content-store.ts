import { existsSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';

export interface SyncState {
  ahead: number;
  behind: number;
  upstream?: string;
  lastFetchAt?: Date;
}

export interface StoreStatus {
  path: string;
  exists: boolean;
  isGitRepo: boolean;
  remote?: string;
  sync?: SyncState;
}

export interface InitResult {
  ok: true;
}

export interface SyncResult {
  ok: boolean;
  updatedCommits?: number;
  message: string;
}

export interface ContentStore {
  status(): Promise<StoreStatus>;
  init(url: string, force: boolean): Promise<InitResult>;
  sync(): Promise<SyncResult>;
}

export function openContentStore(targetPath: string): ContentStore {
  return new ContentStoreImpl(targetPath);
}

class ContentStoreImpl implements ContentStore {
  constructor(private readonly target: string) {}

  async status(): Promise<StoreStatus> {
    if (!existsSync(this.target)) {
      return { path: this.target, exists: false, isGitRepo: false };
    }
    if (!existsSync(path.join(this.target, '.git'))) {
      return { path: this.target, exists: true, isGitRepo: false };
    }
    const git = simpleGit(this.target);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    return {
      path: this.target,
      exists: true,
      isGitRepo: true,
      remote: origin?.refs.fetch,
    };
  }

  async init(url: string, force: boolean): Promise<InitResult> {
    if (existsSync(this.target)) {
      if (!force) {
        throw new Error(
          `${this.target} already exists. Run \`suit sync\` to update, ` +
            `or \`suit init --force <url>\` to overwrite.`,
        );
      }
      rmSync(this.target, { recursive: true, force: true });
    }
    mkdirSync(path.dirname(this.target), { recursive: true });
    const git = simpleGit();
    await git.clone(url, this.target);
    return { ok: true };
  }

  async sync(): Promise<SyncResult> {
    throw new Error('not implemented yet');
  }
}
