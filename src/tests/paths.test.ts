import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSuitPaths } from '../lib/paths.js';

describe('resolveSuitPaths', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), 'suit-paths-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns default XDG paths when no env overrides', () => {
    const paths = resolveSuitPaths({ HOME: tmpHome });
    expect(paths.contentDir).toBe(path.join(tmpHome, '.local', 'share', 'suit', 'content'));
    expect(paths.userOverlayDir).toBe(path.join(tmpHome, '.config', 'suit'));
    expect(paths.projectOverlayName).toBe('.suit');
  });

  it('honors XDG_DATA_HOME for contentDir', () => {
    const paths = resolveSuitPaths({ HOME: tmpHome, XDG_DATA_HOME: '/custom/data' });
    expect(paths.contentDir).toBe(path.join('/custom/data', 'suit', 'content'));
  });

  it('honors XDG_CONFIG_HOME for userOverlayDir', () => {
    const paths = resolveSuitPaths({ HOME: tmpHome, XDG_CONFIG_HOME: '/custom/cfg' });
    expect(paths.userOverlayDir).toBe(path.join('/custom/cfg', 'suit'));
  });

  it('SUIT_CONTENT_PATH overrides contentDir absolutely', () => {
    const paths = resolveSuitPaths({ HOME: tmpHome, SUIT_CONTENT_PATH: '/some/where' });
    expect(paths.contentDir).toBe('/some/where');
  });

  it('treats empty SUIT_CONTENT_PATH as unset', () => {
    const paths = resolveSuitPaths({ HOME: tmpHome, SUIT_CONTENT_PATH: '   ' });
    expect(paths.contentDir).toBe(path.join(tmpHome, '.local', 'share', 'suit', 'content'));
  });
});
