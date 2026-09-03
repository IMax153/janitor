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
    // to a deployed cluster Worker; the sync request still needs to look
    // same-origin to that Worker, so the proxy rewrites the origin.
    proxy: {
      "/api": {
        target: process.env.JANITOR_API_ORIGIN ?? "https://janitor.effectful.co",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest-setup.ts"],
  },
})
