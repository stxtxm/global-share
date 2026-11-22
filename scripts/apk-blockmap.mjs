#!/usr/bin/env node
// Blockmap de l'APK, sur le même principe que les .blockmap d'electron-builder :
// empreinte SHA-256 de chaque bloc. L'application compare ces empreintes avec
// celles de l'APK installé et ne télécharge que les blocs manquants (HTTP Range).
// Usage : node scripts/apk-blockmap.mjs GlobalShare-1.2.3.apk GlobalShare-1.2.3.apk.blockmap
import crypto from 'node:crypto';
import fs from 'node:fs';

const [apkPath, outputPath] = process.argv.slice(2);
if (!apkPath || !outputPath) {
  console.error('Usage: node scripts/apk-blockmap.mjs <apk> <blockmap>');
  process.exit(1);
}

const BLOCK_SIZE = 64 * 1024;
const bytes = fs.readFileSync(apkPath);
const blocks = [];
for (let offset = 0; offset < bytes.length; offset += BLOCK_SIZE) {
  const chunk = bytes.subarray(offset, Math.min(offset + BLOCK_SIZE, bytes.length));
  blocks.push(crypto.createHash('sha256').update(chunk).digest('base64'));
}

fs.writeFileSync(
  outputPath,
  JSON.stringify({ version: 1, fileSize: bytes.length, blockSize: BLOCK_SIZE, blocks }),
);
console.log(`${outputPath}: ${bytes.length} octets, ${blocks.length} blocs`);
