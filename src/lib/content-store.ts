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
  /**
   * Inspect the cache. With `checkRemote: true` we fetch origin and populate
   * `StoreStatus.sync` (best-effort: offline / network failure leaves sync
   * undefined rather than throwing).
   */
  status(opts?: { checkRemote?: boolean }): Promise<StoreStatus>;
  init(url: string, force: boolean): Promise<InitResult>;
  sync(): Promise<SyncResult>;
}

export function openContentStore(targetPath: string): ContentStore {
  return new ContentStoreImpl(targetPath);
}

class ContentStoreImpl implements ContentStore {
  constructor(private readonly target: string) {}

  async status(opts?: { checkRemote?: boolean }): Promise<StoreStatus> {
    if (!existsSync(this.target)) {
      return { path: this.target, exists: false, isGitRepo: false };
    }
    if (!existsSync(path.join(this.target, '.git'))) {
      return { path: this.target, exists: true, isGitRepo: false };
    }
    const git = simpleGit(this.target);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');

    let sync: SyncState | undefined;
    if (opts?.checkRemote && origin) {
      sync = await this.computeSyncState(git);
    }

    return {
      path: this.target,
      exists: true,
      isGitRepo: true,
      remote: origin?.refs.fetch,
      sync,
    };
  }

  /**
   * Best-effort upstream divergence check. Fetches origin (refs only — no
   * objects pulled into the working tree), then asks git for the
   * left/right count between HEAD and the upstream branch.
   *
   * Returns `undefined` (not an error) if anything goes wrong: offline,
   * detached HEAD, no upstream tracking, network timeout, repository
   * corruption. `suit status` should still print a useful summary even when
   * we can't reach the remote.
   */
  private async computeSyncState(git: ReturnType<typeof simpleGit>): Promise<SyncState | undefined> {
    try {
      // Bound the fetch — offline / slow networks shouldn't make `suit status`
      // hang. We export GIT_HTTP_LOW_SPEED_* via process.env (rather than
      // simple-git's .env() chain, which replaces the entire env and breaks
      // PATH lookups).
      process.env.GIT_HTTP_LOW_SPEED_LIMIT = process.env.GIT_HTTP_LOW_SPEED_LIMIT ?? '1000';
      process.env.GIT_HTTP_LOW_SPEED_TIME = process.env.GIT_HTTP_LOW_SPEED_TIME ?? '5';
      await git.fetch(['--quiet', '--no-tags', 'origin']);

      // What does HEAD track? `@{u}` resolves to the upstream branch (e.g.
      // origin/main) — fails if no tracking, in which case there's nothing to
      // compare against. Catch and bail.
      const upstream = (await git.revparse(['--abbrev-ref', '@{u}'])).trim();
      if (!upstream) return undefined;

      // `git rev-list --left-right --count HEAD...@{u}` returns "behind\tahead"
      // (the file-format quirk: HEAD is the LEFT side, so the LEFT count is
      // commits we have that the upstream doesn't = ahead, and RIGHT is commits
      // upstream has that we don't = behind). We use HEAD...@{u} so that the
      // first number is "ahead" (HEAD-only commits) and second is "behind"
      // (upstream-only commits).
      const raw = (await git.raw(['rev-list', '--left-right', '--count', `HEAD...${upstream}`])).trim();
      const parts = raw.split(/\s+/);
      const ahead = Number.parseInt(parts[0] ?? '0', 10);
      const behind = Number.parseInt(parts[1] ?? '0', 10);
      return {
        ahead: Number.isFinite(ahead) ? ahead : 0,
        behind: Number.isFinite(behind) ? behind : 0,
        upstream,
        lastFetchAt: new Date(),
      };
    } catch {
      return undefined;
    }
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
