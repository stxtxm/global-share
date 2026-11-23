'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import {
  formatUpdateBytes,
  INITIAL_UPDATE_STATE,
  normalizeUpdateState,
  type DesktopUpdateBridge,
  type UpdateState,
  type UpdateStatus,
} from '../lib/update';
import { ensureMobileBridge, subscribeMobileBridge } from '../lib/mobile-bridge';

// Un seul abonnement au pont Electron, partagé par le bouton et l'encart.
const stateListeners = new Set<() => void>();
const openListeners = new Set<() => void>();
let currentState: UpdateState = INITIAL_UPDATE_STATE;
let unsubscribeState: (() => void) | void;
let unsubscribeOpen: (() => void) | void;
let stateFetched = false;

function getBridge(): DesktopUpdateBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  // Sur desktop le pont est exposé par Electron, sur Android par Capacitor.
  return window.globalshareDesktop ?? window.globalshareMobile;
}

function applyState(value: unknown) {
  const next = normalizeUpdateState(value);
  const previous = currentState;
  if (
    next.status === previous.status &&
    next.version === previous.version &&
    next.currentVersion === previous.currentVersion &&
    next.percent === previous.percent &&
    next.transferred === previous.transferred &&
    next.total === previous.total &&
    next.bytesPerSecond === previous.bytesPerSecond &&
    next.requiresAdmin === previous.requiresAdmin &&
    next.mode === previous.mode &&
    next.message === previous.message
  ) {
    return;
  }
  currentState = next;
  stateListeners.forEach((listener) => listener());
}

function bindBridge() {
  const bridge = getBridge();
  if (!bridge) return;
  if (!unsubscribeState && bridge.onUpdateState) {
    unsubscribeState = bridge.onUpdateState(applyState);
  }
  if (!unsubscribeOpen && bridge.onUpdateOpen) {
    unsubscribeOpen = bridge.onUpdateOpen(() => openListeners.forEach((listener) => listener()));
  }
  if (!stateFetched && bridge.getUpdateState) {
    stateFetched = true;
    void Promise.resolve(bridge.getUpdateState()).then(applyState).catch(() => {});
  }
}

function useUpdateState(): UpdateState {
  const [, render] = useState(0);
  useEffect(() => {
    const listener = () => render((value) => value + 1);
    stateListeners.add(listener);
    bindBridge();
    return () => {
      stateListeners.delete(listener);
    };
  }, []);
  return currentState;
}

function useOpenRequest(onOpen: () => void) {
  useEffect(() => {
    const listener = () => onOpen();
    openListeners.add(listener);
    bindBridge();
    return () => {
      openListeners.delete(listener);
    };
  }, [onOpen]);
}

// Côté serveur, aucun pont natif n'existe : `useSyncExternalStore` garde le
// premier rendu client identique au HTML serveur, puis lit le pont au montage.
function useHasUpdateHost(): boolean {
  useEffect(() => {
    ensureMobileBridge();
  }, []);
  return useSyncExternalStore(
    subscribeMobileBridge,
    () => Boolean(getBridge()),
    () => false,
  );
}

const actions = {
  check: () => void getBridge()?.checkForUpdates?.(),
  download: () => void getBridge()?.downloadUpdate?.(),
  install: () => void getBridge()?.installUpdate?.(),
  openInstaller: () => void getBridge()?.openInstaller?.().then((error) => {
    if (error) applyState({ ...currentState, status: 'error', message: String(error) });
  }),
  revealInstaller: () => void getBridge()?.revealInstaller?.().then((error) => {
    if (error) applyState({ ...currentState, status: 'error', message: String(error) });
  }),
  retryInstall: () => void getBridge()?.installUpdate?.(),
  dismiss: () => {
    // Retour immédiat : le main publiera l'état confirmé juste après.
    applyState({ ...currentState, status: 'idle', message: '', percent: 0 });
    void getBridge()?.dismissUpdate?.();
  },
};

function UpdateIcon({ className = 'gs-icon' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 1 0-2.3 6.1" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

function DownloadIcon({ className = 'gs-icon' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4v11" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function CheckIcon({ className = 'gs-icon' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4.5 12.5 5 5L19.5 7" />
    </svg>
  );
}

function AlertIcon({ className = 'gs-icon' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5 21.5 20h-19L12 3.5Z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.2v.3" />
    </svg>
  );
}

/** Pictogramme d'état : distinct par situation, lisible sur petit écran. */
function StatusIcon({ status }: { status: UpdateStatus }) {
  if (status === 'downloading' || status === 'installing') return <DownloadIcon />;
  if (status === 'downloaded' || status === 'up-to-date') return <CheckIcon />;
  if (status === 'error' || status === 'unsupported') return <AlertIcon />;
  return <UpdateIcon />;
}

interface TriggerProps {
  open: boolean;
  onToggle: () => void;
}

/** Petit bouton de la barre supérieure : ouvre l'encart et signale une maj. */
export function UpdateTrigger({ open, onToggle }: TriggerProps) {
  const state = useUpdateState();
  const isDesktop = useHasUpdateHost();
  if (!isDesktop) return null;

  const badge = state.status === 'available' || state.status === 'downloaded';
  // Ouvrir l'encart depuis l'état « à jour » ou après une erreur relance
  // directement une recherche : le bouton vaut « rechercher » à lui seul.
  const shouldCheckOnOpen =
    !open && (state.status === 'idle' || state.status === 'up-to-date' || state.status === 'error');

  return (
    <button
      type="button"
      className={`gs-iconbtn gs-update-trigger${open ? ' is-active' : ''}`}
      onClick={() => {
        onToggle();
        if (shouldCheckOnOpen) actions.check();
      }}
      aria-pressed={open}
      aria-label="Mises à jour"
      title="Mises à jour"
    >
      <UpdateIcon />
      {badge && <span className="gs-update-dot" aria-hidden="true" />}
    </button>
  );
}

interface BannerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const AUTO_VISIBLE: ReadonlySet<UpdateStatus> = new Set([
  'available',
  'downloading',
  'downloaded',
  'installing',
  'error',
]);

/** Encart in-app : vérification, téléchargement, progression et installation. */
export function UpdateBanner({ open, onOpenChange }: BannerProps) {
  const state = useUpdateState();
  const isDesktop = useHasUpdateHost();
  useOpenRequest(() => onOpenChange(true));

  if (!isDesktop || (!open && !AUTO_VISIBLE.has(state.status))) return null;

  const transfer =
    state.transferred > 0 && state.total > 0
      ? `${formatUpdateBytes(state.transferred)} / ${formatUpdateBytes(state.total)}`
      : state.bytesPerSecond > 0
        ? `${formatUpdateBytes(state.bytesPerSecond)}/s`
        : '';
  // Temps restant estimé à partir du débit lissé publié par le natif.
  const remaining = Math.max(0, state.total - state.transferred);
  const etaSeconds =
    state.status === 'downloading' && state.bytesPerSecond > 0 && state.total > 0 && remaining > 0
      ? Math.max(1, Math.round(remaining / state.bytesPerSecond))
      : null;
  const eta = etaSeconds === null
    ? ''
    : etaSeconds >= 60
      ? ` · reste ${Math.floor(etaSeconds / 60)} min ${etaSeconds % 60} s`
      : ` · reste ${etaSeconds} s`;
  // Tant que le serveur n'a pas annoncé de taille, la barre est animée : un
  // « 0 % » figé donnerait l'impression que le téléchargement est bloqué.
  const indeterminate =
    state.status === 'installing' ||
    state.status === 'checking' ||
    (state.status === 'downloading' && state.total === 0);
  const showBar =
    state.status === 'checking' || state.status === 'downloading' || state.status === 'installing';

  const close = () => {
    // Fermer une annonce vaut « plus tard » : la version ne sera plus proposée
    // jusqu'à la prochaine vérification.
    if (state.status === 'available' || state.status === 'downloaded') actions.dismiss();
    onOpenChange(false);
  };

  let title = '';
  let detail = state.message;
  const buttons: Array<{ label: string; primary?: boolean; run: () => void }> = [];

  switch (state.status) {
    case 'idle':
      title = `GlobalShare ${state.currentVersion}`;
      detail = 'Vérifier si une nouvelle version est disponible.';
      buttons.push({ label: 'Rechercher', primary: true, run: actions.check });
      break;
    case 'checking':
      title = 'Recherche de mises à jour…';
      detail = '';
      break;
    case 'available':
      title = `Mise à jour disponible · ${state.version}`;
      if (state.mode === 'web') detail = 'Mise à jour rapide : quelques Mo seulement, sans réinstaller l’application.';
      buttons.push({ label: 'Télécharger', primary: true, run: actions.download });
      buttons.push({ label: 'Plus tard', run: close });
      break;
    case 'downloading':
      title = indeterminate ? 'Téléchargement en cours…' : `Téléchargement · ${state.percent}%`;
      detail = transfer || state.message;
      break;
    case 'downloaded':
      title = `${state.version} est prête`;
      if (state.mode === 'web') {
        detail = 'Appliquée en quelques secondes, sans réinstallation ni mot de passe.';
      } else if (state.message.toLowerCase().includes('sources inconnues')) {
        detail = state.message;
      } else {
        detail = state.requiresAdmin
          ? 'L’installation demandera le mot de passe administrateur, puis l’application redémarrera.'
          : 'L’application va redémarrer pour terminer l’installation.';
      }
      buttons.push({
        label: state.mode === 'web' ? 'Appliquer' : 'Installer et redémarrer',
        primary: true,
        run: actions.install,
      });
      buttons.push({ label: 'Plus tard', run: close });
      break;
    case 'installing':
      title = 'Installation en cours…';
      detail = state.message;
      break;
    case 'up-to-date':
      title = 'GlobalShare est à jour';
      break;
    case 'unsupported':
      title = 'Mise à jour indisponible';
      break;
    case 'error':
      title = 'Mise à jour impossible';
      if (typeof getBridge()?.openInstaller === 'function') {
        buttons.push({ label: 'Ouvrir le paquet', run: actions.openInstaller });
      }
      if (state.installerPath && typeof getBridge()?.revealInstaller === 'function') {
        buttons.push({ label: 'Copier dans Fichiers', run: actions.revealInstaller });
      }
      if (state.installerPath && typeof getBridge()?.installUpdate === 'function') {
        buttons.push({ label: 'Retenter l’installation', primary: true, run: actions.retryInstall });
      }
      buttons.push({
        label: 'Réessayer',
        primary: !state.installerPath,
        run: () => {
          onOpenChange(true);
          actions.check();
        },
      });
      break;
  }

  return (
    <section
      className={`gs-update gs-update--${state.status}`}
      role="status"
      aria-live="polite"
      aria-label="Mise à jour de GlobalShare"
    >
      <div className="gs-update-head">
        <span className="gs-update-icon" aria-hidden="true"><StatusIcon status={state.status} /></span>
        <div className="gs-update-text">
          <strong className="gs-update-title">
            {title}
            {state.mode === 'web' && (state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded') && (
              <span className="gs-update-tag">Rapide</span>
            )}
          </strong>
          {detail && <span className="gs-update-detail">{detail}</span>}
        </div>
        <button type="button" className="gs-update-close" onClick={close} aria-label="Fermer l'encart de mise à jour">
          ×
        </button>
      </div>

      {showBar && (
        <div
          className="gs-update-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : state.percent}
          aria-label="Progression de la mise à jour"
        >
          <div
            className={`gs-update-bar-fill${indeterminate ? ' is-indeterminate' : ''}`}
            style={indeterminate ? undefined : { width: `${state.percent}%` }}
          />
        </div>
      )}

      {(buttons.length > 0 || showBar) && (
        <div className="gs-update-actions">
          {showBar && state.status === 'downloading' && !indeterminate && (
            <span className="gs-update-meta">
              {state.percent}% · {transfer}
              {eta}
            </span>
          )}
          {buttons.map(({ label, primary, run }) => (
            <button
              key={label}
              type="button"
              className={`gs-btn gs-btn--sm ${primary ? 'gs-btn--primary' : 'gs-btn--ghost'}`}
              onClick={() => run()}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
