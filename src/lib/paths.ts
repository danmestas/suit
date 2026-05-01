import os from 'node:os';
import path from 'node:path';

export interface SuitPaths {
  contentDir: string;
  userOverlayDir: string;
  projectOverlayName: string;
}

export function resolveSuitPaths(env: NodeJS.ProcessEnv = process.env): SuitPaths {
  // env.HOME first so tests can inject a tmp home; falls back to os.homedir()
  // which is the source of truth on Windows where HOME may be unset.
  const home = env.HOME ?? os.homedir();
  const envContent = env.SUIT_CONTENT_PATH?.trim();

  return {
    contentDir: envContent
      ? path.resolve(envContent)
      : env.XDG_DATA_HOME
        ? path.join(env.XDG_DATA_HOME, 'suit', 'content')
        : path.join(home, '.local', 'share', 'suit', 'content'),
    userOverlayDir: env.XDG_CONFIG_HOME
      ? path.join(env.XDG_CONFIG_HOME, 'suit')
      : path.join(home, '.config', 'suit'),
    projectOverlayName: '.suit',
  };
}
