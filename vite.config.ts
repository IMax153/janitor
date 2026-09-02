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
      "eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
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
      dev: {
        command: "vp exec alchemy dev",
        cache: false,
      },
      "cloudflare:cluster-spike": {
        command: "vp exec alchemy deploy --stage cluster-spike",
        cache: false,
      },
      "cloudflare:cluster-redeploy": {
        command: "vp exec alchemy deploy --stage cluster-spike --force",
        cache: false,
      },
    },
  },
})
