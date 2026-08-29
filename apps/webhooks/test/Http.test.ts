import { assert, describe, it } from "@effect/vitest"
import * as Cloudflare from "alchemy/Cloudflare"
import * as RuntimeContext from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { RateLimitMiddlewareLayer } from "@janitor/webhooks/Middleware"

const runtimeContext = RuntimeContext.RuntimeContext.of({
  Type: "Test",
  id: "test",
  env: {},
  get: <A>() => Effect.succeed<A | undefined>(undefined),
  set: (id) => Effect.succeed(id),
})

type TestRouterRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"GlobalError", Cloudflare.RateLimitError | Schema.SchemaError>
  | HttpRouter.Request<"GlobalRequires", RuntimeContext.RuntimeContext>

const withHandler = <A, E, R>(
  layer: Layer.Layer<never, never, TestRouterRequirements>,
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(layer, {
        disableLogger: true,
        middleware: (app) =>
          app.pipe(
            Effect.orDie,
            Effect.provideService(RuntimeContext.RuntimeContext, runtimeContext),
          ),
      }),
    ),
    ({ handler }) => use(handler),
    ({ dispose }) => Effect.promise(dispose),
  )

const makeLayer = (limit: Cloudflare.RateLimitClient["limit"]) =>
  HttpRouter.add(
    "POST",
    "/probe",
    Effect.succeed(HttpServerResponse.text("Accepted", { status: 202 })),
  ).pipe(
    Layer.provide(RateLimitMiddlewareLayer),
    Layer.provide(
      Layer.succeed(Cloudflare.RateLimit, () =>
        Effect.succeed({
          raw: Effect.die("unused"),
          limit,
        }),
      ),
    ),
  )

describe("RateLimitMiddlewareLayer", () => {
  it.effect("bypasses the limiter without cf-connecting-ip", () => {
    const keys: Array<string> = []

    return withHandler(
      makeLayer(({ key }) =>
        Effect.sync(() => {
          keys.push(key)
          return { success: false }
        }),
      ),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(new Request("https://example.com/probe", { method: "POST" })),
          )

          assert.strictEqual(response.status, 202)
          assert.strictEqual(yield* Effect.promise(() => response.text()), "Accepted")
          assert.deepStrictEqual(keys, [])
        }),
    )
  })

  it.effect("continues with the exact IP key when allowed", () => {
    const keys: Array<string> = []

    return withHandler(
      makeLayer(({ key }) =>
        Effect.sync(() => {
          keys.push(key)
          return { success: true }
        }),
      ),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(
              new Request("https://example.com/probe", {
                method: "POST",
                headers: { "cf-connecting-ip": "203.0.113.10" },
              }),
            ),
          )

          assert.strictEqual(response.status, 202)
          assert.strictEqual(yield* Effect.promise(() => response.text()), "Accepted")
          assert.deepStrictEqual(keys, ["203.0.113.10"])
        }),
    )
  })

  it.effect("returns 429 when denied", () =>
    withHandler(
      makeLayer(() => Effect.succeed({ success: false })),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(
              new Request("https://example.com/probe", {
                method: "POST",
                headers: { "cf-connecting-ip": "203.0.113.11" },
              }),
            ),
          )

          assert.strictEqual(response.status, 429)
          assert.strictEqual(response.headers.get("retry-after"), "60")
          assert.strictEqual(yield* Effect.promise(() => response.text()), "Too Many Requests")
        }),
    ),
  )

  it.effect("returns a safe 500 when the limiter fails", () =>
    withHandler(
      makeLayer(() =>
        Effect.fail(
          new Cloudflare.RateLimitError({
            message: "Rate limiter unavailable",
            cause: new Error("Rate limiter unavailable"),
          }),
        ),
      ),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(
              new Request("https://example.com/probe", {
                method: "POST",
                headers: { "cf-connecting-ip": "203.0.113.12" },
              }),
            ),
          )

          assert.strictEqual(response.status, 500)
          assert.strictEqual(yield* Effect.promise(() => response.text()), "")
        }),
    ),
  )

  it.effect("limits an unmatched path because the middleware is global", () =>
    withHandler(
      makeLayer(() => Effect.succeed({ success: false })),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(
              new Request("https://example.com/missing", {
                method: "POST",
                headers: { "cf-connecting-ip": "203.0.113.13" },
              }),
            ),
          )

          assert.strictEqual(response.status, 429)
          assert.strictEqual(response.headers.get("retry-after"), "60")
          assert.strictEqual(yield* Effect.promise(() => response.text()), "Too Many Requests")
        }),
    ),
  )
})
