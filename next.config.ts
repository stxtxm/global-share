import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === 'production';
// GitHub Pages serves this repository as a project site under /global-share.
const basePath = isProd ? '/global-share' : '';

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
