import * as Alchemy from "alchemy/Stack"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

import ClusterWorker from "@janitor/cluster/Worker"
import WebhookWorker from "@janitor/webhooks/Worker"

export default Alchemy.Stack(
  "Janitor",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const cluster = yield* ClusterWorker
    const webhook = yield* WebhookWorker

    const website = yield* Cloudflare.Website.Foldkit("Website", {
      rootDir: "apps/web",
    })

    return {
      clusterUrl: cluster.url,
      webhooksUrl: webhook.url,
      websiteUrl: website.url,
    }
  }),
)
