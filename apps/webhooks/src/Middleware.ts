import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

const RateLimitHeaders = Schema.Struct({
  "cf-connecting-ip": Schema.OptionFromOptional(Schema.String),
})

export const RateLimitMiddlewareLayer = HttpRouter.middleware(
  Effect.gen(function* () {
    const rateLimit = yield* Cloudflare.RateLimit("WebhookRateLimit", {
      namespaceId: 1,
      simple: { limit: 300, period: 60 },
    })

    return Effect.fnUntraced(function* (app) {
      const headers = yield* HttpServerRequest.schemaHeaders(RateLimitHeaders)
      const ip = headers["cf-connecting-ip"]
      return yield* Option.match(ip, {
        onNone: () => app,
        onSome: Effect.fnUntraced(function* (ip) {
          const limit = yield* rateLimit.limit({ key: ip })
          if (limit.success) {
            return yield* app
          }
          return HttpServerResponse.text("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "60" },
          })
        }),
      })
    })
  }),
  { global: true },
)
