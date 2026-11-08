#!/usr/bin/env node
// Construit l'export statique embarqué dans l'application de bureau.
// Les valeurs par défaut ciblent la production ; chaque variable peut être
// surchargée, par exemple :
//   NEXT_PUBLIC_SOCKET_URL=http://localhost:3001 npm run build:desktop
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const env = {
  ...process.env,
  // Désactive le préfixe /global-share de GitHub Pages : l'application sert
  // l'export à la racine d'un serveur local.
  NEXT_PUBLIC_DESKTOP: '1',
  // Signalisation et relais : l'application de bureau n'a pas d'origine web
  // publique, l'URL du Worker doit donc être fixée au build.
  NEXT_PUBLIC_SOCKET_URL:
    process.env.NEXT_PUBLIC_SOCKET_URL || 'https://global-share-socket.sitizstorm.workers.dev',
  // Les liens de salon partagés depuis l'application pointent vers le site.
  NEXT_PUBLIC_SHARE_BASE:
    process.env.NEXT_PUBLIC_SHARE_BASE || 'https://stxtxm.github.io/global-share',
};

const nextBin = require.resolve('next/dist/bin/next');
const result = spawnSync(process.execPath, [nextBin, 'build'], { stdio: 'inherit', env });

process.exit(result.status ?? 1);
