import { foldkit } from "@foldkit/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite-plus"

export default defineConfig({
  plugins: [tailwindcss(), foldkit({ devToolsMcpPort: 9988 })],
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest-setup.ts"],
  },
})
