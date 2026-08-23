import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

export default Alchemy.Stack(
  "Janitor",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const website = yield* Cloudflare.Website.Foldkit("Website", {
      rootDir: "apps/web",
    })

    return {
      websiteUrl: website.url,
    }
  }),
)
