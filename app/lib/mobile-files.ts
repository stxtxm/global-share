// Enregistrement des fichiers reçus dans le stockage PARTAGÉ d'Android.
//
// Sur le web/desktop, un `<a download>` (blob:) suffit. Dans le WebView
// Capacitor, il dépose le fichier dans un dossier privé invisible de l'app
// Fichiers, et `window.open(blob:)` ne sait pas lancer un lecteur audio —
// d'où le FLAC « cassé » et introuvable. On écrit donc le fichier via le
// plugin natif (MediaStore → Téléchargements/GlobalShare), par morceaux pour
// ne jamais envoyer une chaîne de 80 Mo à travers le pont Capacitor.

import { mobileFinishDownload, mobileSaveDownload } from './mobile-bridge.ts';

/** 256 Ko de données → ~341 Ko de base64 par appel au plugin. */
const CHUNK_BYTES = 256 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // 8 Ko par concaténation : évite de dépasser la limite d'arguments de
  // String.fromCharCode sur les gros tableaux.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

/** Découpe un Blob en morceaux encodés en base64 (testable sans navigateur). */
export async function* blobBase64Chunks(
  blob: Blob,
  chunkBytes = CHUNK_BYTES
): AsyncGenerator<string> {
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    const slice = blob.slice(offset, Math.min(offset + chunkBytes, blob.size));
    yield bytesToBase64(new Uint8Array(await slice.arrayBuffer()));
  }
}

export interface SharedSaveResult {
  /** URI MediaStore (content://…) ou chemin renvoyé par le natif. */
  path?: string;
  error?: string;
}

/**
 * Écrit `blob` dans Téléchargements/GlobalShare/<name> et rend l'URI à
 * conserver dans l'historique pour pouvoir ouvrir le fichier ensuite.
 */
export async function saveBlobToSharedStorage(
  blob: Blob,
  name: string,
  mime: string
): Promise<SharedSaveResult> {
  let uri: string | undefined;
  for await (const chunk of blobBase64Chunks(blob)) {
    const result = await mobileSaveDownload({
      name,
      mime,
      bytes: chunk,
      uri,
      append: Boolean(uri),
    });
    if (result.error) return { error: result.error };
    if (result.uri) uri = result.uri;
    if (!uri) return { error: "Le téléphone n'a pas renvoyé d'emplacement de fichier." };
  }
  const finished = await mobileFinishDownload({ uri, mime });
  if (finished.error) return { error: finished.error };
  // Un fichier vide ne passe dans aucune boucle : on le crée quand même.
  if (!uri) {
    const created = await mobileSaveDownload({ name, mime, bytes: '', uri: undefined, append: false });
    if (created.error) return { error: created.error };
    uri = created.uri;
    if (uri) await mobileFinishDownload({ uri, mime });
  }
  return { path: uri };
}
