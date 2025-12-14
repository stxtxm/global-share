import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  // Base path pour GitHub Pages (optionnel, seulement si le repo n'est pas à la racine)
  // basePath: process.env.NODE_ENV === 'production' ? '/global-share' : '',
  // assetPrefix: process.env.NODE_ENV === 'production' ? '/global-share' : '',
};

export default nextConfig;
