import {
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(ROOT, 'dist');
const SHEBANG = '#!/usr/bin/env node\n';
const BIN_TARGETS = ['dist/ac.js', 'dist/cli.js'];

// 1) Rewrite relative ESM imports to include explicit .js (or /index.js)
//    extensions. tsconfig uses moduleResolution:"Bundler", which lets
//    extensionless imports compile fine but produces invalid Node ESM
//    at runtime. Patch dist/ in place.
const RELATIVE_FROM = /(\bfrom\s+['"])(\.\.?\/[^'"]+)(['"])/g;
const RELATIVE_DYN = /(\bimport\(\s*['"])(\.\.?\/[^'"]+)(['"]\s*\))/g;
const EXPORT_FROM = /(\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"])(\.\.?\/[^'"]+)(['"])/g;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && p.endsWith('.js')) yield p;
  }
}

function fixSpecifier(filePath, spec) {
  // Already has an explicit .js, .mjs, .cjs, .json — leave it.
  if (/\.(m?js|cjs|json)$/.test(spec)) return spec;
  const fileDir = dirname(filePath);
  const target = resolve(fileDir, spec);
  // If the import resolves to a directory, point to its index.js.
  if (existsSync(target) && statSync(target).isDirectory()) {
    return `${spec}/index.js`;
  }
  // Otherwise, append .js (the file should exist next to it).
  return `${spec}.js`;
}

let rewriteCount = 0;
let fileCount = 0;
for (const filePath of walk(DIST)) {
  const original = readFileSync(filePath, 'utf8');
  let body = original;
  const replace = (match, pre, spec, post) => {
    const fixed = fixSpecifier(filePath, spec);
    if (fixed === spec) return match;
    rewriteCount++;
    return `${pre}${fixed}${post}`;
  };
  body = body.replace(RELATIVE_FROM, replace);
  body = body.replace(RELATIVE_DYN, replace);
  body = body.replace(EXPORT_FROM, replace);
  if (body !== original) {
    writeFileSync(filePath, body);
    fileCount++;
  }
}
console.log(`postbuild: rewrote ${rewriteCount} relative imports across ${fileCount} files`);

// 2) Ensure bins have shebang + executable bit.
for (const rel of BIN_TARGETS) {
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
