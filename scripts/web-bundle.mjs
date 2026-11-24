#!/usr/bin/env node
// Construit le « bundle web » publié avec chaque release : un zip de l'export
// statique Next.js (out/) et son manifeste JSON. C'est la pièce maîtresse des
// mises à jour delta : l'application (desktop et Android) ne retélécharge que
// ce zip — environ 1 Mo — au lieu du paquet complet (~80 Mo) tant que la
// coquille native (Electron/Capacitor) n'a pas changé.
//
// Le manifeste embarque la version de la release et `nativeVersion` : les apps
// installées comparent ce champ à leur propre compteur pour décider entre mise
// à jour rapide (web) et téléchargement du paquet complet.
//
// Sortie (dans dist/ par défaut) :
//   web-bundle.zip       contenu racine de out/, déflaté niveau 9
//   web-bundle.json      { version, nativeVersion, sha256, size, notes }
//
// `notes` reprend la section du CHANGELOG de la version publiée : l'app
// installée les affiche dans l'encart de mise à jour avant de télécharger.
//
// Usage : node scripts/web-bundle.mjs [dossier-de-sortie]

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';

import { changelogNotes } from './release-notes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'out');
const distDir = path.resolve(root, process.argv[2] || path.join(root, 'dist'));

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '');
const nativeVersion = Number.isFinite(Number(pkg.nativeVersion)) ? Number(pkg.nativeVersion) : 1;

// L'export doit être à jour : on refuse un index.html manquant ou ancien.
const index = path.join(outDir, 'index.html');
try {
  const info = await stat(index);
  if (!info.isFile()) throw new Error('pas un fichier');
} catch {
  console.error('::error::out/index.html introuvable — lancez « npm run build:desktop » avant ce script.');
  process.exit(1);
}

// Inclusion récursive dans l'ordre stable du parcours : le hash du zip est
// reproductible pour un même contenu.
async function collect(dir, base, files) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name);
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collect(absolute, relative, files);
    else if (entry.isFile()) files.push({ absolute, relative });
  }
}

const files = [];
await collect(outDir, '', files);
if (files.length === 0) {
  console.error('::error::out/ est vide — export statique incomplet.');
  process.exit(1);
}

const zip = new JSZip();
for (const file of files) {
  zip.file(file.relative, await readFile(file.absolute), { compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

const bundle = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 },
});
const notes = await changelogNotes(version);
const sha256 = createHash('sha256').update(bundle).digest('hex');

await mkdir(distDir, { recursive: true });
await writeFile(path.join(distDir, 'web-bundle.zip'), bundle);
await writeFile(
  path.join(distDir, 'web-bundle.json'),
  `${JSON.stringify({ version, nativeVersion, sha256, size: bundle.length, notes }, null, 2)}\n`,
);

const mega = (bundle.length / (1024 * 1024)).toFixed(2);
console.log(`web-bundle.zip : ${mega} Mo (${files.length} fichiers) — version ${version}, nativeVersion ${nativeVersion}`);
