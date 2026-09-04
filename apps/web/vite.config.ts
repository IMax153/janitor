import { foldkit } from "@foldkit/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite-plus"

export default defineConfig({
  plugins: [tailwindcss(), foldkit({ devToolsMcpPort: 9988 })],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
  server: {
    // The app calls its API on the same origin. In development, forward it
    // to the cluster Worker `alchemy dev` serves locally, where Access is
    // simulated. Set JANITOR_API_ORIGIN to point at a deployed stage instead;
    // that stage is behind Access, so also set CF_ACCESS_TOKEN to the output
    // of `cloudflared access token`. The proxy rewrites the origin so the
    // sync request still looks same-origin to the Worker.
    proxy: {
      "/api": {
        target: process.env.JANITOR_API_ORIGIN ?? "http://localhost:8787",
        changeOrigin: true,
        headers:
          process.env.CF_ACCESS_TOKEN === undefined
            ? {}
            : { "cf-access-token": process.env.CF_ACCESS_TOKEN },
      },
    },
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest-setup.ts"],
  },
})
