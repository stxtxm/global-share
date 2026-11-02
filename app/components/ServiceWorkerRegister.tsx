'use client';

import { useEffect } from 'react';

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
    navigator.serviceWorker.register(`${basePath}/sw.js`).catch(() => {
      // ignore
    });
  }, []);

  return null;
}
