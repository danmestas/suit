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
  // sync is populated when status() can compute upstream divergence; reserved
  // for richer reporting in `suit status` (Task 8).
  sync?: SyncState;
}

export interface InitResult {
  ok: boolean;
  message: string;
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
        return {
          ok: false,
          message:
            `${this.target} already exists. Run \`suit sync\` to update, ` +
            `or \`suit init --force <url>\` to overwrite.`,
        };
      }
      rmSync(this.target, { recursive: true, force: true });
    }
    // simple-git's clone() creates the target dir but requires the parent to exist.
    mkdirSync(path.dirname(this.target), { recursive: true });
    const git = simpleGit();
    await git.clone(url, this.target);
    return { ok: true, message: `Cloned ${url} → ${this.target}` };
  }

  async sync(): Promise<SyncResult> {
    if (!existsSync(this.target)) {
      return {
        ok: false,
        message: `${this.target} does not exist. Run \`suit init <url>\` first.`,
      };
    }
    if (!existsSync(path.join(this.target, '.git'))) {
      return {
        ok: false,
        message: `${this.target} is not a git repo. Re-run \`suit init\`.`,
      };
    }
    const git = simpleGit(this.target);
    const status = await git.status();
    if (!status.isClean()) {
      return {
        ok: false,
        message:
          `${this.target} has uncommitted changes. Stash or commit them, then re-run.`,
      };
    }
    const before = (await git.revparse(['HEAD'])).trim();
    await git.pull();
    const after = (await git.revparse(['HEAD'])).trim();
    if (before === after) {
      return { ok: true, updatedCommits: 0, message: 'Already up to date' };
    }
    const log = await git.log({ from: before, to: after });
    return {
      ok: true,
      updatedCommits: log.total,
      message: `Updated ${log.total} commit${log.total === 1 ? '' : 's'}`,
    };
  }
}
