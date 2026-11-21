#!/usr/bin/env node
// Corrige les métadonnées electron-updater après une modification d'un paquet.
// Le workflow signe le .rpm avec rpmsign APRÈS electron-builder : la taille et
// le sha512 écrits dans latest-linux.yml ne correspondent alors plus au fichier
// téléchargé, et electron-updater refuse l'installation (« checksum mismatch »).
// Usage : node scripts/fix-release-checksum.mjs dist/latest-linux.yml globalshare-1.0.9.x86_64.rpm
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [metadataPath, fileName] = process.argv.slice(2);
if (!metadataPath || !fileName) {
  console.error('Usage: node scripts/fix-release-checksum.mjs <latest.yml> <fichier paquet>');
  process.exit(1);
}

const directory = path.dirname(metadataPath);
const packagePath = path.join(directory, fileName);
const bytes = fs.readFileSync(packagePath);
const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
const size = bytes.length;

const lines = fs.readFileSync(metadataPath, 'utf8').split(/\r?\n/);
const entry = lines.findIndex((line) => line.trim() === `- url: ${fileName}`);
if (entry === -1) {
  console.error(`${fileName} absent de ${metadataPath}`);
  process.exit(1);
}

let foundHash = false;
let foundSize = false;
for (let index = entry + 1; index < Math.min(entry + 6, lines.length); index += 1) {
  if (lines[index].startsWith('    sha512:')) {
    lines[index] = `    sha512: ${sha512}`;
    foundHash = true;
  } else if (lines[index].startsWith('    size:')) {
    lines[index] = `    size: ${size}`;
    foundSize = true;
  } else if (lines[index].startsWith('  - url:') || lines[index].startsWith('path:')) {
    break;
  }
}
if (!foundHash || !foundSize) {
  console.error(`Champs sha512/taille introuvables pour ${fileName} dans ${metadataPath}`);
  process.exit(1);
}

// Quand le paquet modifié est aussi le fichier principal (`path`), son sha512
// global doit être corrigé lui aussi.
const mainPath = lines.find((line) => line.startsWith('path: '))?.slice(6).trim();
if (mainPath === fileName) {
  const pathIndex = lines.findIndex((line) => line.startsWith('path: '));
  for (let index = pathIndex + 1; index < Math.min(pathIndex + 4, lines.length); index += 1) {
    if (lines[index].startsWith('sha512:')) {
      lines[index] = `sha512: ${sha512}`;
      break;
    }
  }
}

fs.writeFileSync(metadataPath, `${lines.join('\n')}\n`);
console.log(`${fileName}: sha512=${sha512} size=${size}`);
