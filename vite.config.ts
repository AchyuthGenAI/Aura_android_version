import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const requestedPort = Number(process.env.AURA_DEV_PORT || "5173");
const devPort = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 5173;

export default defineConfig({
  base: "./",
  envPrefix: ["VITE_", "PLASMO_PUBLIC_"],
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "src/shared"),
      "@renderer": path.resolve(__dirname, "src/renderer")
    }
  },
  server: {
    host: "127.0.0.1",
    port: devPort,
    strictPort: false
  },
  build: {
    outDir: "dist/renderer"
  }
});
