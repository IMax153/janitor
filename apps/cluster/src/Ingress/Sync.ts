import { SyncSummary } from "@janitor/domain/GitHub/Sync"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { SyncStatus } from "../SyncStatus.ts"

const respondSummary = HttpServerResponse.schemaJson(SyncSummary)

const forbiddenResponse = HttpServerResponse.text("Forbidden", { status: 403 })
const serviceUnavailableResponse = HttpServerResponse.text("Service Unavailable", {
  status: 503,
  headers: { "Retry-After": "10" },
})

/**
 * Interim boundary for a state-changing browser request: the request must
 * come from the page Janitor itself serves. Cloudflare Access verification
 * (design: "Human APIs") slots in ahead of this once it exists; it is not the
 * finished authorization story.
 */
const isSameOrigin = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const fetchSite = request.headers["sec-fetch-site"]
  if (fetchSite !== undefined) {
    return fetchSite === "same-origin"
  }
  const origin = request.headers["origin"]
  if (origin === undefined) {
    return false
  }
  return new URL(origin).host === new URL(request.originalUrl).host
}

export const SameOriginMiddleware = HttpRouter.middleware((app) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    isSameOrigin(request) ? app : Effect.succeed(forbiddenResponse),
  ),
).layer

const unavailable = (operation: string) =>
  Effect.fnUntraced(function* (cause: unknown) {
    yield* Effect.logError(`Sync ${operation} failed`, cause)
    return serviceUnavailableResponse
  })

export const SyncSummaryRoute = HttpRouter.add(
  "GET",
  "/sync",
  Effect.gen(function* () {
    const status = yield* SyncStatus
    const summary = yield* status.summary
    return yield* respondSummary(summary)
  }).pipe(Effect.catchCause(unavailable("summary"))),
)

export const SyncRequestRoute = HttpRouter.add(
  "POST",
  "/sync",
  Effect.gen(function* () {
    const status = yield* SyncStatus
    const result = yield* status.requestAll
    return yield* respondSummary(result.summary, { status: 202 })
  }).pipe(Effect.catchCause(unavailable("request"))),
).pipe(Layer.provide(SameOriginMiddleware))

export const SyncRoutesLayer = Layer.mergeAll(SyncSummaryRoute, SyncRequestRoute)
