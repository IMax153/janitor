import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { RoutesLayer } from "./Http.ts"

export default class WebhookWorker extends Cloudflare.Worker<WebhookWorker>()(
  "WebhookWorker",
  {
    main: import.meta.url,
    compatibility: { flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const HttpPlatformStubLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
      platform: "web",
      compression: {
        algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
        compressResponse: () =>
          Effect.die("HttpPlatform.compression.compressResponse not supported"),
      },
      fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
      fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse not supported"),
    })

    const MainLayer = RoutesLayer.pipe(
      Layer.provide([Etag.layer, HttpPlatformStubLayer, Path.layer]),
    )

    const fetch = yield* HttpRouter.toHttpEffect(MainLayer)

    return {
      fetch: Effect.orElseSucceed(fetch, () => HttpServerResponse.empty({ status: 500 })),
    }
  }).pipe(
    Effect.provide([Cloudflare.Queues.WriteQueueBinding, Cloudflare.Workers.RateLimitBinding]),
  ),
) {}
