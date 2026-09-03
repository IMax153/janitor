import * as Cloudflare from "alchemy/Cloudflare"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { type AccessIdentity, AccessVerifier } from "./AccessJwt.ts"

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

/** The verified Access identity of the current request. */
export class CurrentAccessIdentity extends Context.Service<CurrentAccessIdentity, AccessIdentity>()(
  "@janitor/cluster/Ingress/Middleware/CurrentAccessIdentity",
) {}

const unauthorizedResponse = HttpServerResponse.empty({ status: 401 })

/**
 * Admits a request only when it carries an assertion the `AccessVerifier`
 * accepts, and makes the identity available to the route. Failures answer
 * 401 with an empty body: the browser is redirected to the Access login by
 * Cloudflare before it ever reaches here, so anything that arrives without a
 * valid assertion is not a person who needs a hint.
 */
export const AccessMiddleware = HttpRouter.middleware<{ provides: CurrentAccessIdentity }>()(
  Effect.gen(function* () {
    const verifier = yield* AccessVerifier

    return Effect.fnUntraced(function* (app) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const assertion = request.headers["cf-access-jwt-assertion"]
      if (assertion === undefined) {
        yield* Effect.logWarning("Access assertion missing")
        return unauthorizedResponse
      }
      const identity = yield* verifier.verify(assertion).pipe(
        Effect.catchTags({
          AccessAssertionRejected: (error) =>
            Effect.logWarning("Access assertion rejected", error.reason).pipe(Effect.as(undefined)),
          AccessKeysUnavailable: (error) =>
            Effect.logError("Access signing keys unavailable", error.cause).pipe(
              Effect.as(undefined),
            ),
        }),
      )
      if (identity === undefined) {
        return unauthorizedResponse
      }
      return yield* app.pipe(
        Effect.provideService(CurrentAccessIdentity, identity),
        Effect.annotateLogs({ accessIssuer: identity.issuer, accessSubject: identity.subject }),
      )
    })
  }),
)

export const AccessMiddlewareLayer = AccessMiddleware.layer
