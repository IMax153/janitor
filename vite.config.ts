import { defineConfig } from "vite-plus"

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    semi: false,
  },
  lint: {
    plugins: ["typescript", "effecttsgo"],
    jsPlugins: [
      {
        name: "foldkit",
        specifier: "@foldkit/oxlint-plugin",
      },
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  run: {
    cache: true,

    tasks: {
      "dev:web": {
        command: "vp -C apps/web dev",
        cache: false,
      },
    },
  },
})
