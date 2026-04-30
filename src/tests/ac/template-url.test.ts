import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('suit.templateUrl in package.json', () => {
  it('is configured and is a valid URL', () => {
    const pkgPath = path.join(REPO_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    expect(pkg.suit).toBeDefined();
    expect(pkg.suit.templateUrl).toBeTruthy();
    expect(typeof pkg.suit.templateUrl).toBe('string');
    expect(pkg.suit.templateUrl).toMatch(/^https:\/\/github\.com\//);
  });

  it('points at danmestas/suit-template', () => {
    const pkgPath = path.join(REPO_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    expect(pkg.suit.templateUrl).toBe('https://github.com/danmestas/suit-template');
  });
});
