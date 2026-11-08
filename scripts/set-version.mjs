#!/usr/bin/env node
// Aligne la version des deux package.json sur le tag publié (ex. v1.2.0).
// Le tag reste la source de vérité : une release ne peut pas partir avec une
// version différente de celle annoncée.
import fs from 'node:fs';

const tag = (process.env.RELEASE_TAG || '').trim();
const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);

if (!match) {
  console.error(
    `Tag « ${tag || '(vide)'} » invalide : attendu v<major>.<minor>.<patch>, par exemple v1.2.0.`,
  );
  process.exit(1);
}

const version = match[1];

for (const file of ['package.json', 'desktop/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${file} → ${version}`);
}
