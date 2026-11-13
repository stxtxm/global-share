// Maintien de l'écran allumé pendant un transfert.
//
// Un téléphone qui s'éteint gèle la page : la socket tombe, plus rien ne circule
// et le transfert s'arrête. La Wake Lock API empêche au moins l'extinction
// automatique. Le verrouillage manuel (bouton power) reste possible, et c'est la
// reprise automatique du transfert qui rattrape ce cas.
//
// Aucune dépendance : `navigator` n'est touché qu'à l'appel, donc le module
// reste importable côté serveur (rendu Next).

interface ScreenWakeLockSentinel {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
}

// Type minimal plutôt que celui de lib.dom : l'API n'existe pas partout, et
// `Navigator` déclare déjà `wakeLock` comme toujours présent dans certaines
// versions de TypeScript.
type WakeLockCapableNavigator = {
  wakeLock?: {
    request: (type: 'screen') => Promise<ScreenWakeLockSentinel>;
  };
};

let sentinel: ScreenWakeLockSentinel | null = null;

export function isScreenWakeLockSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean((navigator as unknown as WakeLockCapableNavigator).wakeLock)
  );
}

/** Demande le verrou d'écran ; false si l'API refuse ou n'existe pas. */
export async function keepScreenAwake(): Promise<boolean> {
  if (!isScreenWakeLockSupported()) return false;
  if (sentinel && !sentinel.released) return true;

  try {
    const lock = await (navigator as unknown as WakeLockCapableNavigator).wakeLock!.request(
      'screen'
    );
    sentinel = lock;
    // Le navigateur relâche le verrou de lui-même (page masquée, batterie
    // faible) : on oublie la référence pour pouvoir le redemander au retour.
    lock.addEventListener?.('release', () => {
      if (sentinel === lock) sentinel = null;
    });
    return true;
  } catch {
    // Refus (permission, batterie) : le transfert continue, l'écran peut
    // seulement s'éteindre.
    return false;
  }
}

export async function releaseScreenWakeLock(): Promise<void> {
  const lock = sentinel;
  sentinel = null;
  if (!lock || lock.released) return;
  try {
    await lock.release();
  } catch {
    // Déjà relâché par le navigateur.
  }
}
