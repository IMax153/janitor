/**
 * Compiles `theme.css` against the classes used in the HTML files here.
 * There is no Tailwind CLI in this workspace, so this drives the same
 * compiler the Vite plugin uses.
 *
 *   node docs/mockups/tw/build.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

// The Tailwind compiler is a transitive dependency of `@tailwindcss/vite`,
// so it is not resolvable from this directory. Resolve it from the web app,
// which does depend on the plugin.
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/"))
// `@tailwindcss/vite` does not export its package.json, so resolve the entry
// and walk up to the `@tailwindcss` directory that holds `node` and `oxide`.
const tailwindDir = dirname(dirname(dirname(require.resolve("@tailwindcss/vite"))))
const { compile } = await import(join(tailwindDir, "node/dist/index.mjs"))
const { Scanner } = await import(join(tailwindDir, "oxide/index.js"))

const here = dirname(fileURLToPath(import.meta.url))
const pages = readdirSync(here).filter((file) => file.endsWith(".html"))

// `@import "tailwindcss"` resolves from `base`, so compile as if the file
// sat in the web app, where tailwindcss is a dependency.
const webApp = join(here, "../../../apps/web")
const compiler = await compile(readFileSync(join(here, "theme.css"), "utf8"), {
  base: webApp,
  onDependency: () => {},
})

const scanner = new Scanner({ sources: [{ base: here, pattern: "**/*.html", negated: false }] })
const candidates = scanner.scan()

for (const page of pages) {
  writeFileSync(join(here, page.replace(/\.html$/, ".css")), compiler.build(candidates))
}

console.log(`built ${pages.length} page(s) from ${candidates.length} candidates`)
