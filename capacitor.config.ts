import type { CapacitorConfig } from '@capacitor/cli';

// L'APK embarque le même export statique Next.js que l'application de bureau.
// Aucun serveur tiers : Capacitor sert `out/` depuis le WebView natif.
const config: CapacitorConfig = {
  appId: 'io.github.stxtxm.globalshare',
  appName: 'GlobalShare',
  webDir: 'out',
  android: {
    // Les ressources sont locales et HTTPS : aucun contenu mixte autorisé.
    allowMixedContent: false,
  },
};

export default config;
