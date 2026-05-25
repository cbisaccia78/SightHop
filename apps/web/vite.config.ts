import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const certPath = resolve("../../infra/certs/sighthop-dev.crt");
const keyPath = resolve("../../infra/certs/sighthop-dev.key");
const useHttps = process.env.SIGHTHOP_HTTPS === "true" && existsSync(certPath) && existsSync(keyPath);

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ["itchy-ghosts-run.loca.lt", "sweet-donkey-36.loca.lt", "192.168.1.163"],
    https: useHttps ? {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath)
    } : undefined,
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true
      },
      "/socket.io": {
        target: "http://localhost:3000",
        changeOrigin: true,
        ws: true
      }
    }
  }
});
