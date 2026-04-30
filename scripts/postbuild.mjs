import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SHEBANG = '#!/usr/bin/env node\n';
const TARGETS = ['dist/ac.js', 'dist/cli.js'];

for (const rel of TARGETS) {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) {
    console.error(`postbuild: missing ${rel}`);
    process.exit(1);
  }
  let body = readFileSync(abs, 'utf8');
  if (!body.startsWith('#!')) body = SHEBANG + body;
  writeFileSync(abs, body);
  chmodSync(abs, 0o755);
  console.log(`postbuild: prepared ${rel}`);
}
