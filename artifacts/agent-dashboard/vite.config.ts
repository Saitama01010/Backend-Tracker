import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const rootEnv = loadEnv(process.env.NODE_ENV ?? "development", repoRoot, "");
const isBuild = process.argv.includes("build");

function envValue(name: string): string | undefined {
  const value = process.env[name] ?? rootEnv[name];
  return value && value.trim() ? value : undefined;
}

const rawPort = envValue("DASHBOARD_PORT");
const port = rawPort ? Number(rawPort) : 3000;

if (!isBuild && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid DASHBOARD_PORT value: "${rawPort}"`);
}

const basePath = envValue("BASE_PATH") ?? "/";
const apiPort = envValue("API_PORT") ?? envValue("PORT") ?? "8080";
const apiProxyTarget = envValue("API_PROXY_TARGET") ?? `http://localhost:${apiPort}`;

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
