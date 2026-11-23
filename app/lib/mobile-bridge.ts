// Pont Android (Capacitor). Capacitor injecte `window.Capacitor` dans le WebView
// avant la page : aucun import JS n'est nécessaire, le site web garde son
// bundle inchangé et le pont n'existe que dans l'APK.

import type { DesktopUpdateBridge } from './update';

interface ListenerHandle {
  remove: () => void | Promise<void>;
}

interface GlobalShareNativePlugin {
  getUpdateState(): Promise<unknown>;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  installUpdate(): Promise<unknown>;
  dismissUpdate(): Promise<unknown>;
  requestPermissions(options?: { permissions?: string[] }): Promise<unknown>;
  startTransfer(options: { count: number; progress: number }): Promise<unknown>;
  updateTransferProgress(options: { count: number; progress: number }): Promise<unknown>;
  stopTransfer(): Promise<unknown>;
  keepAlive(options: { enabled: boolean }): Promise<unknown>;
  requestBatteryExemption(): Promise<unknown>;
  saveDownload(options: {
    name: string; mime: string; bytes: string; uri?: string; append?: boolean;
  }): Promise<{ uri?: string; path?: string; error?: string }>;
  finishDownload(options: { uri?: string; mime?: string }): Promise<{ error?: string }>;
  openDownload(options: { uri: string; mime?: string; name?: string }): Promise<{ error?: string }>;
  revealDownload(): Promise<{ error?: string }>;
  deleteDownload(options: { uri?: string; name: string }): Promise<{ deleted?: boolean; error?: string }>;
  listDownloads(): Promise<{ files?: { uri: string; name: string; size: number }[]; error?: string }>;
  getServiceState?(): Promise<unknown>;
  addListener(eventName: string, listener: (value: unknown) => void): Promise<ListenerHandle>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  registerPlugin?: <T>(name: string) => T;
}

declare global {
  interface Window {
    Capacitor?: CapacitorGlobal;
    globalshareMobile?: DesktopUpdateBridge;
  }
}

let cachedPlugin: GlobalShareNativePlugin | undefined;

/**
 * Récupère le proxy natif du plugin. Deux sources possibles : l'objet
 * `window.Capacitor.Plugins` peuplé nativement (JSExport injecte, pour chaque
 * plugin enregistré, un objet avec `addListener` et les méthodes en
 * `Promise`), ou `registerPlugin` du paquet `@capacitor/core`. Attention :
 * `registerPlugin` n'est PAS exposé dans le WebView natif — s'y limiter rend
 * le pont indisponible sur tous les appareils.
 */
function nativePlugin(): GlobalShareNativePlugin | undefined {
  if (cachedPlugin) return cachedPlugin;
  if (typeof window === 'undefined') return undefined;
  const capacitor = (window.Capacitor ?? undefined) as
    | (CapacitorGlobal & { Plugins?: Record<string, GlobalShareNativePlugin> })
    | undefined;
  if (!capacitor?.isNativePlatform?.()) return undefined;
  const injected = capacitor.Plugins?.GlobalShareNative;
  if (injected) {
    cachedPlugin = injected;
    return cachedPlugin;
  }
  const registered = capacitor.registerPlugin?.<GlobalShareNativePlugin>('GlobalShareNative');
  if (registered) cachedPlugin = registered;
  return cachedPlugin;
}

function subscribe(event: string, listener: (value: unknown) => void): () => void {
  const plugin = nativePlugin();
  if (!plugin) return () => {};
  let handle: ListenerHandle | undefined;
  // Selon le mode d'injection, `addListener` renvoie soit un handle
  // synchrone (pont natif `window.Capacitor.addListener`), soit une Promesse.
  try {
    const result = plugin.addListener(event, listener) as
      | ListenerHandle
      | Promise<ListenerHandle>
      | undefined;
    if (result && typeof (result as Promise<ListenerHandle>)?.then === 'function') {
      void (result as Promise<ListenerHandle>)
        .then((value) => {
          handle = value;
        })
        .catch(() => {});
    } else {
      handle = result as ListenerHandle;
    }
  } catch {
    // L'appareil refuse l'abonnement : l'UI restera sur l'état demandé.
  }
  return () => {
    if (handle) void handle.remove();
  };
}

/**
 * Le bundle web peut être plus récent que la coquille native (mise à jour delta
 * `nativeVersion` identique). Dans ce cas une méthode du plugin n'existe pas et
 * l'appel direct lève un TypeError. On renvoie un message actionnable à la
 * place, et la release suivante incrémente nativeVersion pour forcer l'APK.
 */
function missingNative(feature: string): string {
  return `Fonction « ${feature} » indisponible : mettez l'APK à jour depuis les Réglages.`;
}

/** Un appel natif rejeté (service interdit en arrière-plan, permission refusée)
 *  ne doit jamais devenir une rejection non gérée : le silence rendait le
 *  blocage impossible à diagnostiquer. */
function invoke(result: Promise<unknown> | undefined): void {
  void result?.catch((error) => {
    console.warn('[GlobalShare] appel natif refusé', error);
  });
}

const bridgeListeners = new Set<() => void>();

/** Abonné par l'interface : prévient React que le pont natif est disponible. */
export function subscribeMobileBridge(listener: () => void): () => void {
  bridgeListeners.add(listener);
  ensureMobileBridge();
  return () => {
    bridgeListeners.delete(listener);
  };
}

/**
 * Installe le pont dès que `window.Capacitor` existe. Suivant la version
 * d'Android, le script natif est injecté au début du document OU en fin de
 * page : on réessaie donc au chargement et pendant les premières secondes,
 * sinon le bouton de mise à jour n'apparaît jamais.
 */
export function ensureMobileBridge(): boolean {
  if (typeof window === 'undefined' || window.globalshareMobile) {
    return typeof window !== 'undefined' && Boolean(window.globalshareMobile);
  }
  const plugin = nativePlugin();
  if (!plugin) return false;

  window.globalshareMobile = {
    isDesktop: false,
    getUpdateState: () => plugin.getUpdateState(),
    checkForUpdates: () => plugin.checkForUpdates(),
    downloadUpdate: () => plugin.downloadUpdate(),
    installUpdate: () => plugin.installUpdate(),
    dismissUpdate: () => plugin.dismissUpdate(),
    onUpdateState: (listener) => subscribe('updateState', listener),
    onUpdateOpen: (listener) => subscribe('updateOpen', () => listener()),
    // Tick émis par le service avant-plan toutes les 10 s : il tourne même
    // quand les timers du WebView sont bridés par la veille (Chrome 88+).
    onServiceTick: (listener) => subscribe('serviceTick', () => listener()),
  };
  bridgeListeners.forEach((listener) => listener());
  return true;
}

ensureMobileBridge();
if (typeof window !== 'undefined') {
  window.addEventListener('load', ensureMobileBridge);
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    ensureMobileBridge();
    if (window.globalshareMobile || attempts >= 40) clearInterval(timer);
  }, 200);
}

export function isMobileHost(): boolean {
  if (typeof window === 'undefined') return false;
  ensureMobileBridge();
  return Boolean(window.globalshareMobile);
}

export function mobileStartTransfer(count: number, progress: number): void {
  const plugin = nativePlugin();
  if (!plugin) return;
  void (async () => {
    // Notification permanente obligatoire sur Android 13+ pour le service.
    try {
      await plugin.requestPermissions({ permissions: ['notifications'] });
    } catch {
      // Refus : le service démarre quand même (Android affiche alors sa propre
      // notification de gestion des tâches).
    }
    invoke(plugin.startTransfer({ count, progress }));
  })();
}

export function mobileUpdateTransfer(count: number, progress: number): void {
  invoke(nativePlugin()?.updateTransferProgress({ count, progress }));
}

export function mobileStopTransfer(): void {
  invoke(nativePlugin()?.stopTransfer());
}

/** Transferts terminés : le service reste vivant si la session est ouverte. */
export function mobileFinishTransfer(): void {
  invoke(nativePlugin()?.updateTransferProgress({ count: 0, progress: 0 }));
}

/**
 * Session salon connectée : maintient le service avant-plan (wake locks) pour
 * que la socket survive à l'arrière-plan et à la veille, même sans transfert.
 */
export function mobileKeepAlive(enabled: boolean): void {
  invoke(nativePlugin()?.keepAlive({ enabled }));
}

/** État natif (wake locks, service) pour le diagnostic dans les réglages. */
export function mobileServiceState(): Promise<unknown> | undefined {
  return nativePlugin()?.getServiceState?.();
}

/**
 * Exemption d'optimisation de batterie : demandée une seule fois par
 * installation côté natif (le plugin ignore les redemandes).
 */
export function mobileRequestBatteryExemption(): void {
  invoke(nativePlugin()?.requestBatteryExemption());
}

// ---- Fichiers reçus (stockage partagé Android) ---------------------------

export async function mobileSaveDownload(options: {
  name: string; mime: string; bytes: string; uri?: string; append?: boolean;
}): Promise<{ uri?: string; path?: string; error?: string }> {
  const plugin = nativePlugin();
  if (typeof plugin?.saveDownload !== 'function') {
    return { error: missingNative('Enregistrement des fichiers') };
  }
  try {
    return (await plugin.saveDownload(options)) ?? { error: 'Pont Android indisponible.' };
  } catch (error) {
    return { error: String(error) };
  }
}

export async function mobileFinishDownload(options: {
  uri?: string; mime?: string;
}): Promise<{ error?: string }> {
  const plugin = nativePlugin();
  if (typeof plugin?.finishDownload !== 'function') return {};
  try {
    return (await plugin.finishDownload(options)) ?? {};
  } catch (error) {
    return { error: String(error) };
  }
}

export interface SharedFile {
  uri: string;
  name: string;
  size: number;
}

/** Fichiers réellement présents dans Téléchargements/GlobalShare. */
export async function mobileListDownloads(): Promise<{ files: SharedFile[]; error?: string }> {
  if (!isMobileHost()) return { files: [] };
  const plugin = nativePlugin();
  if (typeof plugin?.listDownloads !== 'function') {
    return { files: [], error: missingNative('Liste des fichiers') };
  }
  try {
    const result = await plugin.listDownloads();
    return { files: result?.files ?? [], error: result?.error };
  } catch (error) {
    return { files: [], error: String(error) };
  }
}

/** Supprime le fichier du stockage partagé (Retirer dans l'app). */
export async function mobileDeleteDownload(options: {
  uri?: string; name: string;
}): Promise<{ deleted?: boolean; error?: string }> {
  const plugin = nativePlugin();
  if (typeof plugin?.deleteDownload !== 'function') {
    return { error: missingNative('Suppression des fichiers') };
  }
  try {
    return (await plugin.deleteDownload(options)) ?? { error: 'Pont Android indisponible.' };
  } catch (error) {
    return { error: String(error) };
  }
}

/** Ouvre l'application Fichiers sur Téléchargements/GlobalShare. */
export async function mobileRevealDownload(): Promise<string> {
  const plugin = nativePlugin();
  if (typeof plugin?.revealDownload !== 'function') return missingNative('Fichiers');
  try {
    const result = await plugin.revealDownload();
    return result?.error ?? (result ? '' : "Application Fichiers indisponible.");
  } catch (error) {
    return String(error);
  }
}

/** Ouvre le fichier avec l'application système choisie (ACTION_VIEW + chooser). */
export async function mobileOpenDownload(options: {
  uri: string; mime?: string; name?: string;
}): Promise<string> {
  const plugin = nativePlugin();
  if (typeof plugin?.openDownload !== 'function') return missingNative('Ouvrir avec');
  try {
    const result = await plugin.openDownload(options);
    return result?.error ?? (result ? '' : "Aucune application d'ouverture disponible.");
  } catch (error) {
    return String(error);
  }
}
