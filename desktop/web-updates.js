'use strict';

// Mises à jour « bundle web » : la coquille native (Electron) embarque un
// export statique de ~2 Mo dans un paquet de ~80 Mo. Tant que la coquille
// n'a pas changé (`nativeVersion` identique), une release ne doit retélécharger
// que le zip web et son manifeste, jamais le paquet complet.
//
// Ce module est volontairement dépendant de rien (ni Electron ni réseau au
// chargement) : tout est injecté par configure(). updater.js le pilote et
// main.js ne s'en sert que pour connaître le dossier web actif.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

// Doit être activé explicitement : main.js le fait pour une vraie installation.
const config = {
  enabled: false,
  baseDir: null, // <userData>
  appVersion: null,
  nativeVersion: null,
  fetchImpl: null,
  releasesUrl: 'https://github.com/stxtxm/global-share/releases/latest/download',
};

const MANIFEST_TIMEOUT_MS = 15_000;

let applied = null; // { version, nativeVersion, dir }

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------
function finite(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Comparaison « 1.2.10 » vs « 1.10.1 » : numérique par segment, comme en Java. */
function compareVersions(left, right) {
  const toParts = (value) =>
    String(value || '')
      .split('-')[0]
      .split('.')
      .slice(0, 4)
      .map((part) => {
        const number = Number.parseInt(part, 10);
        return Number.isFinite(number) ? number : 0;
      });
  const a = toParts(left);
  const b = toParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function versionDirsRoot() {
  return path.join(config.baseDir, 'web');
}

function pointerFile() {
  return path.join(config.baseDir, 'web.json');
}

function versionDir(version) {
  // Les versions viennent d'un manifeste validé : au pire caractère hors
  // créneau, on neutralise (aucun `../` ne doit franchir versionDirsRoot()).
  const clean = String(version).replace(/[^0-9A-Za-z._-]/g, '_');
  return path.join(versionDirsRoot(), clean);
}

function readPointer() {
  try {
    const raw = JSON.parse(fs.readFileSync(pointerFile(), 'utf8'));
    if (typeof raw.version !== 'string' || typeof raw.dir !== 'string') return null;
    if (!fs.existsSync(path.join(raw.dir, 'index.html'))) return null;
    return { version: raw.version, nativeVersion: finite(raw.nativeVersion, 0), dir: raw.dir };
  } catch {
    return null;
  }
}

function validManifest(value) {
  if (!value || typeof value !== 'object') return null;
  const version = typeof value.version === 'string' ? value.version : '';
  const sha256 = typeof value.sha256 === 'string' ? value.sha256.toLowerCase() : '';
  if (!/^\d+(\.\d+){1,3}$/.test(version)) return null;
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const size = finite(value.size, 0);
  if (size <= 0 || size > 256 * 1024 * 1024) return null;
  const nativeVersion = finite(value.nativeVersion, -1);
  if (nativeVersion < 0) return null;
  return { version, nativeVersion, sha256, size };
}

// ---------------------------------------------------------------------------
// Check : manifeste le plus léger possible (aucune API rate-limitée, une seule
// requête) ; un échec réseau renvoie null, l'appelant retombe sur
// electron-updater.
// ---------------------------------------------------------------------------
async function check() {
  if (!config.enabled || !config.baseDir) return null;
  if (applied === null) applied = readPointer();

  let raw = null;
  try {
    const response = await config.fetchImpl(`${config.releasesUrl}/web-bundle.json`, {
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    raw = await response.json();
  } catch {
    return null;
  }

  const manifest = validManifest(raw);
  if (!manifest) return null;

  const effective = effectiveVersion();
  if (compareVersions(manifest.version, effective) <= 0) {
    return { available: false, version: manifest.version, mode: 'web' };
  }
  // Coquille obsolète : la même release doit passer par electron-updater.
  if (manifest.nativeVersion !== config.nativeVersion) {
    return { available: false, version: manifest.version, mode: 'full', nativeChanged: true };
  }
  return {
    available: true,
    mode: 'web',
    version: manifest.version,
    nativeVersion: manifest.nativeVersion,
    sha256: manifest.sha256,
    size: manifest.size,
  };
}

// ---------------------------------------------------------------------------
// Download : zip + empreinte vérifiée, extraction atomique dans
// <userData>/web/<version>. Progression publiée par updater.js via onProgress.
// ---------------------------------------------------------------------------
async function download({ version, sha256, size }, onProgress) {
  if (!config.enabled || !config.baseDir) throw new Error('Bundle web désactivé.');

  const target = versionDir(version);
  const staging = `${target}.staging`;
  fs.rmSync(staging, { recursive: true, force: true });

  const zipPath = path.join(config.baseDir, 'web-bundle.zip');
  try {
    const response = await config.fetchImpl(`${config.releasesUrl}/web-bundle.zip`);
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

    await fs.promises.mkdir(config.baseDir, { recursive: true });
    await pipeline(response.body, fs.createWriteStream(zipPath));

    if (onProgress) {
      const total = size || fs.statSync(zipPath).size;
      onProgress(100, total, total, 0);
    }

    const actual = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    if (actual !== String(sha256).toLowerCase()) {
      throw new Error('L’empreinte SHA-256 du bundle web diffère de la release.');
    }

    await extractZip(zipPath, staging);
    if (!fs.existsSync(path.join(staging, 'index.html'))) {
      throw new Error('Le bundle web téléchargé est incomplet (index.html manquant).');
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    return target;
  } finally {
    // Le zip est consommé : vérifié puis extrait, il n'a plus lieu d'être.
    try {
      fs.unlinkSync(zipPath);
    } catch {
      // déjà absent
    }
  }
}

// Extraction sans dépendance : le zip produit par scripts/web-bundle.mjs est
// simple (déflaté, pas de zip64). On parse le répertoire central et on refuse
// tout chemin qui sortirait du dossier cible (zip-slip).
async function extractZip(zipPath, destination) {
  const buffer = fs.readFileSync(zipPath);

  // End of Central Directory : signature PK\x05\x06, cherchée depuis la fin.
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 65536); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('Archive web invalide (EOCD introuvable).');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  let cursor = centralOffset;
  await fs.promises.mkdir(destination, { recursive: true });
  const resolvedDestination = path.resolve(destination);

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Archive web invalide (entrée corrompue).');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (name) {
      const targetPath = path.resolve(destination, name);
      if (targetPath !== resolvedDestination && !targetPath.startsWith(resolvedDestination + path.sep)) {
        throw new Error(`Entrée suspecte dans l'archive : ${name}`);
      }
      if (name.endsWith('/')) {
        fs.mkdirSync(targetPath, { recursive: true });
      } else {
        // Local file header : la taille y est aussi, avec le champ extra propre.
        const extraNameLength = buffer.readUInt16LE(localOffset + 26);
        const extraFieldLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + extraNameLength + extraFieldLength;

        const raw = buffer.subarray(dataStart, dataStart + compressedSize);
        let content;
        if (method === 0) content = Buffer.from(raw);
        else if (method === 8) content = await new Promise((resolve, reject) => {
          const inflate = require('node:zlib').inflateRaw;
          inflate(raw, (error, result) => (error ? reject(new Error(`Archive web illisible : ${error.message}`)) : resolve(result)));
        });
        else throw new Error(`Compression non prise en charge (${method}).`);

        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, content);
      }
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
}

// ---------------------------------------------------------------------------
// Apply / état
// ---------------------------------------------------------------------------
function apply(version, nativeVersion) {
  if (!config.baseDir) throw new Error('Bundle web désactivé.');
  const dir = versionDir(version);
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    throw new Error('Bundle web introuvable sur le disque.');
  }
  applied = { version, nativeVersion: finite(nativeVersion, 0), dir };
  const payload = JSON.stringify(applied);
  const placeholder = `${pointerFile()}.tmp`;
  fs.writeFileSync(placeholder, payload);
  fs.renameSync(placeholder, pointerFile());
  pruneOldVersions(version);
  return dir;
}

function pruneOldVersions(keepVersion) {
  try {
    for (const entry of fs.readdirSync(versionDirsRoot(), { withFileTypes: true })) {
      if (entry.name === keepVersion) continue;
      if (entry.isDirectory() && (entry.name.endsWith('.staging') || /^\d+(\.\d+){1,3}$/.test(entry.name))) {
        fs.rmSync(path.join(versionDirsRoot(), entry.name), { recursive: true, force: true });
      }
    }
  } catch {
    // Pas bloquant : les vieux dossiers seront nettoyés à la prochaine apply.
  }
}

function activeRoot() {
  if (!config.enabled || !config.baseDir) return null;
  if (applied === null) applied = readPointer();
  return applied ? applied.dir : null;
}

function appliedVersion() {
  if (!config.enabled || !config.baseDir) return null;
  if (applied === null) applied = readPointer();
  return applied ? applied.version : null;
}

function effectiveVersion() {
  const current = appliedVersion();
  if (!current) return config.appVersion;
  return compareVersions(current, config.appVersion) > 0 ? current : config.appVersion;
}

/** L'utilisateur a拒绝了 un bundle : on revient aux ressources embarquées. */
function reset() {
  if (config.baseDir) {
    try {
      fs.rmSync(pointerFile(), { force: true });
    } catch {
      // rien à faire
    }
  }
  applied = null;
}

function configure(options = {}) {
  Object.assign(config, options);
  applied = null;
}

module.exports = {
  apply,
  appliedVersion,
  activeRoot,
  check,
  compareVersions,
  configure,
  download,
  effectiveVersion,
  extractZip,
  reset,
  validManifest,
};
