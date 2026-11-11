import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// En desarrollo, /api se reenvía al backend para evitar problemas de CORS.
// Cambie VITE_PROXY_API si el backend no está en localhost:3000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_PROXY_API ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
