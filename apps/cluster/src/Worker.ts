import * as AlchemyCloudflareCluster from "@effect/platform-cloudflare/AlchemyCloudflareCluster"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

export default class ClusterWorker extends Cloudflare.Worker<ClusterWorker>()(
  "ClusterWorker",
  {
    main: import.meta.url,
    compatibility: { flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const cluster = yield* AlchemyCloudflareCluster.make({
      entities: [],
      layer: Layer.empty,
    })

    return {
      fetch: cluster.provide(Effect.succeed(HttpServerResponse.text("Janitor cluster probe"))),
    }
  }),
) {}
