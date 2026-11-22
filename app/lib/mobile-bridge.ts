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
    await plugin.startTransfer({ count, progress });
  })();
}

export function mobileUpdateTransfer(count: number, progress: number): void {
  void nativePlugin()?.updateTransferProgress({ count, progress });
}

export function mobileStopTransfer(): void {
  void nativePlugin()?.stopTransfer();
}

/**
 * Session salon connectée : maintient le service avant-plan (wake locks) pour
 * que la socket survive à l'arrière-plan et à la veille, même sans transfert.
 */
export function mobileKeepAlive(enabled: boolean): void {
  void nativePlugin()?.keepAlive({ enabled });
}

/**
 * Exemption d'optimisation de batterie : demandée une seule fois par
 * installation côté natif (le plugin ignore les redemandes).
 */
export function mobileRequestBatteryExemption(): void {
  void nativePlugin()?.requestBatteryExemption();
}
