// Extraction des notes de version depuis CHANGELOG.md.
//
// Utilisé par deux chemins qui doivent rester cohérents :
// - scripts/web-bundle.mjs, qui embarque les notes dans `web-bundle.json` ;
// - le workflow de release, qui publie le corps de la release GitHub lu par
//   l'APK Android pour afficher les mêmes notes avant d'installer.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Section du CHANGELOG pour cette version, sans le titre ni les séparateurs. */
export async function changelogNotes(version, changelog = path.join(root, 'CHANGELOG.md')) {
  const clean = String(version || '').replace(/^v/, '').trim();
  if (!clean) return '';
  try {
    const markdown = await readFile(changelog, 'utf8');
    const lines = markdown.split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith(`## [${clean}]`));
    if (start < 0) return '';
    const section = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^##\s/.test(lines[index])) break;
      section.push(lines[index]);
    }
    return section.join('\n').replace(/^\s*---\s*$/gm, '').trim().slice(0, 6000);
  } catch {
    return '';
  }
}

// CLI : `node scripts/release-notes.mjs 1.0.51 > notes.md`. Sortie vide et
// code 1 si la section manque, pour que l'appelant puisse se rabattre.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const notes = await changelogNotes(process.argv[2]);
  if (notes) {
    process.stdout.write(`${notes}\n`);
  } else {
    process.exitCode = 1;
  }
}
