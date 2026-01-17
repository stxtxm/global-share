import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === 'production';
const basePath = isProd ? '' : ''; // Suppression du basePath pour Render

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
  },
};

export default nextConfig;
