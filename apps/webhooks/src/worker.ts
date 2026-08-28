import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { handle } from "./handler.ts"
import { WebhookQueue as WebhookQueueService, WebhookRateLimit, WebhookSecret } from "./services.ts"

export const WebhookQueue = Cloudflare.Queues.Queue("WebhookQueue")

export default class WebhookWorker extends Cloudflare.Worker<WebhookWorker>()(
  "WebhookWorker",
  {
    main: import.meta.url,
    compatibility: { flags: ["no_nodejs_compat"] },
  },
  Effect.gen(function* () {
    const queue = yield* Cloudflare.Queues.WriteQueue(WebhookQueue)
    const rateLimit = yield* Cloudflare.RateLimit("WebhookRateLimit", {
      namespaceId: 1,
      simple: { limit: 300, period: 60 },
    })
    const secret = yield* Config.schema(
      Schema.Redacted(Schema.NonEmptyString),
      "GITHUB_WEBHOOK_SECRET",
    )

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const runtimeContext = yield* Alchemy.RuntimeContext
        return yield* handle(request).pipe(
          Effect.provideService(
            WebhookRateLimit,
            WebhookRateLimit.of({
              limit: (key) =>
                rateLimit
                  .limit({ key })
                  .pipe(Effect.provideService(Alchemy.RuntimeContext, runtimeContext)),
            }),
          ),
          Effect.provideService(WebhookSecret, secret),
          Effect.provideService(
            WebhookQueueService,
            WebhookQueueService.of({
              send: (message) =>
                queue
                  .send(message)
                  .pipe(Effect.provideService(Alchemy.RuntimeContext, runtimeContext)),
            }),
          ),
        )
      }),
    }
  }).pipe(
    Effect.provide(Cloudflare.Queues.WriteQueueBinding),
    Effect.provide(Cloudflare.Workers.RateLimitBinding),
  ),
) {}
