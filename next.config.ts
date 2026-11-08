import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === 'production';
// L'application de bureau (Electron) sert l'export à la racine d'un serveur
// local : le préfixe de GitHub Pages n'a pas lieu d'être.
const isDesktop = process.env.NEXT_PUBLIC_DESKTOP === '1';
// GitHub Pages serves this repository as a project site under /global-share.
const basePath = isProd && !isDesktop ? '/global-share' : '';

// URL du serveur WebSocket en fonction de l'environnement
const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || '';

const nextConfig: NextConfig = {
  output: 'export',
  basePath: basePath,
  assetPrefix: basePath,
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_SOCKET_URL: socketUrl,
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
