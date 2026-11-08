import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Processus principal Electron : CommonJS sans bundler, où require() est la
  // forme d'import attendue.
  {
    files: ["desktop/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "socket-server-cloudflare/**",
    // Paquets Electron produits par electron-builder : ils embarquent une
    // copie de l'export Next.js, inutile à relire.
    "dist/**",
  ]),
]);

export default eslintConfig;
