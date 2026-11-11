#!/usr/bin/env node
/**
 * devtools-ASTeroids — Extension Build Script (`npm run build`)
 *
 * Assembles the production extension directory inside `dist/`, syncing the version
 * from `package.json` into `dist/manifest.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

export function buildExtension() {
  // Clean and recreate dist/
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });

  // Copy all extension assets from src/ -> dist/
  copyRecursive(srcDir, distDir);

  // Sync version from package.json into src/manifest.json and dist/manifest.json
  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  for (const mPath of [path.join(srcDir, 'manifest.json'), path.join(distDir, 'manifest.json')]) {
    const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    manifest.version = pkg.version;
    fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  console.log(`[ASTeroids] Built dist/ (version v${pkg.version})`);
  return { version: pkg.version, distDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  buildExtension();
}
