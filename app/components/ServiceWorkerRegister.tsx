'use client';

import { useEffect } from 'react';

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Dans l'application de bureau, les fichiers sont déjà locaux et le service
    // worker ne servirait qu'un export périmé après une mise à jour.
    if (process.env.NEXT_PUBLIC_DESKTOP === '1') return;
    if (!('serviceWorker' in navigator)) return;

    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
    navigator.serviceWorker.register(`${basePath}/sw.js`).catch(() => {
      // ignore
    });
  }, []);

  return null;
}
