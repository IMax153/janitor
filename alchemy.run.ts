import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

import WebhookWorker from "@janitor/webhooks/worker"

export default Alchemy.Stack(
  "Janitor",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const webhook = yield* WebhookWorker

    const website = yield* Cloudflare.Website.Foldkit("Website", {
      rootDir: "apps/web",
    })

    return {
      webhooksUrl: webhook.url,
      websiteUrl: website.url,
    }
  }),
)
