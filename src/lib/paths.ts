import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

export interface SuitPaths {
  contentDir: string;
  userOverlayDir: string;
  projectOverlayName: string;
  legacyUserOverlayDir: string;
  legacyProjectOverlayName: string;
}

export interface ResolveResult {
  paths: SuitPaths;
  warnings: string[];
}

export function resolveSuitPaths(env: NodeJS.ProcessEnv = process.env): ResolveResult {
  // env.HOME first so tests can inject a tmp home; falls back to os.homedir()
  // which is the source of truth on Windows where HOME may be unset.
  const home = env.HOME ?? os.homedir();
  const envContent = env.SUIT_CONTENT_PATH?.trim();

  const paths: SuitPaths = {
    contentDir: envContent
      ? path.resolve(envContent)
      : env.XDG_DATA_HOME
        ? path.join(env.XDG_DATA_HOME, 'suit', 'content')
        : path.join(home, '.local', 'share', 'suit', 'content'),
    userOverlayDir: env.XDG_CONFIG_HOME
      ? path.join(env.XDG_CONFIG_HOME, 'suit')
      : path.join(home, '.config', 'suit'),
    projectOverlayName: '.suit',
    legacyUserOverlayDir: path.join(home, '.config', 'agent-config'),
    legacyProjectOverlayName: '.agent-config',
  };

  const warnings: string[] = [];
  // NOTE: project-overlay legacy (.agent-config/) detection lives in the
  // project-tier resolver (Task 10) which has cwd context.
  if (existsSync(paths.legacyUserOverlayDir) && !existsSync(paths.userOverlayDir)) {
    warnings.push(
      `[suit] WARNING: ${paths.legacyUserOverlayDir} is deprecated. ` +
        `Move to ${paths.userOverlayDir}. Legacy path will be removed in v0.3.`,
    );
  }

  return { paths, warnings };
}
