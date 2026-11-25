// Dossier de réception des fichiers reçus.
//
// Sur desktop (Electron) et Android, l'application enregistre les fichiers
// reçus dans un dossier dédié, que l'utilisateur peut changer ici. Un
// navigateur web ne le permet pas (le téléchargement est imposé par le
// navigateur) : `getReceiveFolder()` renvoie alors null et le réglage n'est
// pas affiché.

import {
  mobileChooseReceiveFolder,
  mobileGetReceiveFolder,
  mobileResetReceiveFolder,
  type ReceiveFolderInfo,
} from './mobile-bridge.ts';

export type { ReceiveFolderInfo };

export interface ReceiveFolderFile {
  path: string;
  name: string;
  size: number;
  /** Date de dernière modification (ms depuis l'époque Unix). */
  modified: number;
}

interface DesktopReceiveFolderBridge {
  getDownloadFolder?: () => Promise<Partial<ReceiveFolderInfo> & { error?: string }>;
  chooseDownloadFolder?: () => Promise<
    Partial<ReceiveFolderInfo> & { canceled?: boolean; error?: string }
  >;
  resetDownloadFolder?: () => Promise<Partial<ReceiveFolderInfo> & { error?: string }>;
  listDownloads?: () => Promise<{
    folder?: string; files?: ReceiveFolderFile[]; error?: string;
  }>;
  openDownloadFolder?: () => Promise<string>;
}

function desktopBridge(): DesktopReceiveFolderBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.globalshareDesktop as unknown as
    | DesktopReceiveFolderBridge
    | undefined;
}

/** true quand la page tourne dans la coquille Electron (dossier de réception local). */
export function isDesktopHost(): boolean {
  return Boolean(desktopBridge());
}

/**
 * Fichiers présents dans le dossier de réception du bureau. Contrairement au
 * mobile, le pont Electron n'est pas asynchrone à installer : la liste peut
 * être demandée dès l'ouverture de l'onglet.
 */
export async function listReceiveFolderFiles(): Promise<{
  folder?: string; files: ReceiveFolderFile[]; error?: string;
}> {
  const desktop = desktopBridge();
  if (typeof desktop?.listDownloads !== 'function') {
    return { files: [], error: 'Liste des fichiers indisponible : mettez l’application à jour.' };
  }
  try {
    const result = await desktop.listDownloads();
    return {
      folder: result?.folder,
      files: result?.files ?? [],
      error: result?.error,
    };
  } catch (error) {
    return { files: [], error: String(error) };
  }
}

/** Ouvre le dossier de réception dans le gestionnaire de fichiers du système. */
export async function openReceiveFolder(): Promise<string> {
  const desktop = desktopBridge();
  if (typeof desktop?.openDownloadFolder !== 'function') {
    return 'Ouverture du dossier indisponible : mettez l’application à jour.';
  }
  try {
    return (await desktop.openDownloadFolder()) || '';
  } catch (error) {
    return String(error);
  }
}

export type ReceiveFolderResult =
  | { folder: ReceiveFolderInfo }
  | { canceled: true }
  | { error: string };

/** Dossier courant, ou null quand la plateforme ne permet pas de le choisir. */
export async function getReceiveFolder(): Promise<ReceiveFolderInfo | null> {
  const desktop = desktopBridge();
  if (desktop?.getDownloadFolder && desktop.chooseDownloadFolder) {
    try {
      const result = await desktop.getDownloadFolder();
      if (result?.path) {
        return { path: result.path, custom: Boolean(result.custom) };
      }
    } catch {
      // Pont momentanément indisponible : on retombe sur le mobile.
    }
  }
  return mobileGetReceiveFolder();
}

export async function chooseReceiveFolder(): Promise<ReceiveFolderResult> {
  const desktop = desktopBridge();
  if (desktop?.chooseDownloadFolder) {
    try {
      const result = await desktop.chooseDownloadFolder();
      if (result?.canceled) return { canceled: true };
      if (result?.error) return { error: result.error };
      if (result?.path) {
        return { folder: { path: result.path, custom: Boolean(result.custom) } };
      }
      return { error: "Le dossier n'a pas été renvoyé." };
    } catch (error) {
      return { error: String(error) };
    }
  }
  const mobile = await mobileChooseReceiveFolder();
  if (mobile.canceled) return { canceled: true };
  if (mobile.error) return { error: mobile.error };
  if (mobile.folder) return { folder: mobile.folder };
  return { error: "Le dossier n'a pas été renvoyé." };
}

export async function resetReceiveFolder(): Promise<ReceiveFolderResult> {
  const desktop = desktopBridge();
  if (desktop?.resetDownloadFolder) {
    try {
      const result = await desktop.resetDownloadFolder();
      if (result?.error) return { error: result.error };
      if (result?.path) {
        return { folder: { path: result.path, custom: Boolean(result.custom) } };
      }
      return { error: "Le dossier n'a pas été renvoyé." };
    } catch (error) {
      return { error: String(error) };
    }
  }
  const mobile = await mobileResetReceiveFolder();
  if (mobile.error) return { error: mobile.error };
  if (mobile.folder) return { folder: mobile.folder };
  return { error: "Le dossier n'a pas été renvoyé." };
}