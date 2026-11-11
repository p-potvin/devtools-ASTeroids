#!/usr/bin/env node
/**
 * devtools-ASTeroids — Automated Release Packager (`npm run dist`)
 *
 * Called after `npm version patch --no-git-tag-version`.
 * 1. Syncs the bumped version from `package.json` into `src/manifest.json` and `dist/manifest.json`.
 * 2. Builds `dist/`.
 * 3. Packages `dist/` into `release/devtools-asteroids-v<version>.zip` using a cross-platform
 *    pure-Node ZIP archive writer (zero external binary dependencies required).
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildExtension } from './build.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// CRC32 Lookup Table for standard ZIP archive headers
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function collectFiles(baseDir, relDir = '') {
  const results = [];
  const currentDir = path.join(baseDir, relDir);
  for (const entry of fs.readdirSync(currentDir)) {
    const relPath = relDir ? `${relDir}/${entry}` : entry;
    const fullPath = path.join(baseDir, relPath);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...collectFiles(baseDir, relPath));
    } else {
      results.push({ relPath: relPath.replace(/\\/g, '/'), fullPath });
    }
  }
  return results;
}

/**
 * Creates a standard PKZIP archive buffer from a directory using DEFLATE compression.
 */
function createZipArchive(sourceDir) {
  const files = collectFiles(sourceDir);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const rawData = fs.readFileSync(file.fullPath);
    const compressed = zlib.deflateRawSync(rawData, { level: 9 });
    const nameBuf = Buffer.from(file.relPath, 'utf8');
    const crc = crc32(rawData);

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);         // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6);     // UTF-8 flag
    localHeader.writeUInt16LE(8, 8);          // compression method (8 = deflate)
    localHeader.writeUInt16LE(0, 10);         // mod time
    localHeader.writeUInt16LE(0x566b, 12);    // mod date
    localHeader.writeUInt32LE(crc, 14);       // crc32
    localHeader.writeUInt32LE(compressed.length, 18); // compressed size
    localHeader.writeUInt32LE(rawData.length, 22);    // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);    // filename length
    localHeader.writeUInt16LE(0, 28);                 // extra length

    localParts.push(localHeader, nameBuf, compressed);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4);         // version made by
    centralHeader.writeUInt16LE(20, 6);         // version needed
    centralHeader.writeUInt16LE(0x0800, 8);     // UTF-8 flag
    centralHeader.writeUInt16LE(8, 10);         // compression method
    centralHeader.writeUInt16LE(0, 12);         // mod time
    centralHeader.writeUInt16LE(0x566b, 14);    // mod date
    centralHeader.writeUInt32LE(crc, 16);       // crc32
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);         // extra length
    centralHeader.writeUInt16LE(0, 32);         // comment length
    centralHeader.writeUInt16LE(0, 34);         // disk number
    centralHeader.writeUInt16LE(0, 36);         // internal attrs
    centralHeader.writeUInt32LE(0, 38);         // external attrs
    centralHeader.writeUInt32LE(offset, 42);    // local header offset

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);            // EOCD signature
  eocd.writeUInt16LE(0, 4);                     // disk number
  eocd.writeUInt16LE(0, 6);                     // central dir start disk
  eocd.writeUInt16LE(files.length, 8);          // entries on disk
  eocd.writeUInt16LE(files.length, 10);         // total entries
  eocd.writeUInt32LE(centralBuffer.length, 12); // central dir size
  eocd.writeUInt32LE(offset, 16);               // central dir offset
  eocd.writeUInt16LE(0, 20);                    // comment length

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

const { version, distDir } = buildExtension();
const releaseDir = path.join(rootDir, 'release');
fs.mkdirSync(releaseDir, { recursive: true });

const zipFileName = `devtools-asteroids-v${version}.zip`;
const zipFilePath = path.join(releaseDir, zipFileName);
const zipBuffer = createZipArchive(distDir);
fs.writeFileSync(zipFilePath, zipBuffer);

console.log(`[ASTeroids] Packaged release/${zipFileName} (${(zipBuffer.length / 1024).toFixed(1)} KB)`);
