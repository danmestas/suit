import { existsSync } from 'node:fs';
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

  async init(_url: string, _force: boolean): Promise<InitResult> {
    throw new Error('not implemented yet');
  }

  async sync(): Promise<SyncResult> {
    throw new Error('not implemented yet');
  }
}
