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

function nativePlugin(): GlobalShareNativePlugin | undefined {
  if (cachedPlugin) return cachedPlugin;
  if (typeof window === 'undefined') return undefined;
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.() || !capacitor.registerPlugin) return undefined;
  cachedPlugin = capacitor.registerPlugin<GlobalShareNativePlugin>('GlobalShareNative');
  return cachedPlugin;
}

function subscribe(event: string, listener: (value: unknown) => void): () => void {
  const plugin = nativePlugin();
  if (!plugin) return () => {};
  let handle: ListenerHandle | undefined;
  void plugin.addListener(event, listener).then((value) => { handle = value; }).catch(() => {});
  return () => {
    if (handle) void handle.remove();
  };
}

function install() {
  if (typeof window === 'undefined' || window.globalshareMobile) return;
  const plugin = nativePlugin();
  if (!plugin) return;

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
}

// Exécuté à l'import, avant le premier rendu : l'encart de mise à jour trouve
// déjà le pont quand il s'abonne au montage.
install();

export function isMobileHost(): boolean {
  return typeof window !== 'undefined' && Boolean(window.globalshareMobile);
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
