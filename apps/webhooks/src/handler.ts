import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import {
  DeliveryId,
  normalizePullRequest,
  normalizePush,
  parseJson,
  type WebhookMessage,
} from "./model.ts"
import { Signature, verifySignature } from "./signature.ts"
import { WebhookQueue, WebhookRateLimit, WebhookSecret } from "./services.ts"

const MaxBodyBytes = 1024 * 1024

class Rejection extends Data.TaggedError("Rejection")<{
  readonly status: number
  readonly headers?: Record<string, string>
}> {}

const reject = (status: number, headers?: Record<string, string>) =>
  new Rejection({ status, ...(headers === undefined ? {} : { headers }) })

const decodeHeader = Effect.fn("Webhook.decodeHeader")(function* <A>(
  schema: Schema.Codec<A, string>,
  value: string | undefined,
  status: number,
) {
  if (value === undefined) return yield* reject(status)
  return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => reject(status)),
  )
})

const response = (status: number, headers?: Record<string, string>) =>
  HttpServerResponse.empty({ status, ...(headers === undefined ? {} : { headers }) })

interface BodyState {
  readonly chunks: ReadonlyArray<Uint8Array>
  readonly size: number
}

const appendBodyChunk = (state: BodyState, chunk: Uint8Array): BodyState => {
  const remaining = MaxBodyBytes + 1 - state.size
  if (remaining <= 0) return state
  const next = chunk.slice(0, remaining)
  return { chunks: [...state.chunks, next], size: state.size + next.byteLength }
}

const readBody = Effect.fn("Webhook.readBody")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const initial = { chunks: [], size: 0 } satisfies BodyState
  const state = yield* request.stream.pipe(
    Stream.scan(initial, appendBodyChunk),
    Stream.takeUntil((current) => current.size > MaxBodyBytes),
    Stream.runLast,
    Effect.map(Option.getOrElse(() => initial)),
    Effect.catch(() =>
      request.arrayBuffer.pipe(
        Effect.map((buffer) => appendBodyChunk(initial, new Uint8Array(buffer))),
      ),
    ),
    Effect.mapError(() => reject(500)),
  )
  if (state.size > MaxBodyBytes) return yield* reject(413)

  const body = new Uint8Array(state.size)
  let offset = 0
  for (const chunk of state.chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
})

export const handle = Effect.fn("Webhook.handle")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const program = Effect.gen(function* () {
    if (new URL(request.originalUrl).pathname !== "/webhooks/github") return yield* reject(404)
    if (request.method !== "POST") {
      return yield* reject(405, { Allow: "POST" })
    }

    const rateLimit = yield* WebhookRateLimit
    const key = Option.getOrElse(request.remoteAddress, () => "unknown")
    const limit = yield* rateLimit.limit(key).pipe(Effect.mapError(() => reject(503)))
    if (!limit.success) {
      return yield* reject(429, { "Retry-After": "60" })
    }

    const signature = yield* decodeHeader(Signature, request.headers["x-hub-signature-256"], 401)
    const event = request.headers["x-github-event"]
    if (event === undefined) return yield* reject(400)
    const deliveryId = yield* decodeHeader(DeliveryId, request.headers["x-github-delivery"], 400)

    const contentLength = request.headers["content-length"]
    if (contentLength !== undefined && Number(contentLength) > MaxBodyBytes) {
      return yield* reject(413)
    }
    const body = yield* readBody(request)

    const secret = yield* WebhookSecret
    const verified = yield* verifySignature(secret, signature, body).pipe(
      Effect.mapError(() => reject(503)),
    )
    if (!verified) return yield* reject(401)

    if (event !== "push" && event !== "pull_request") return response(204)

    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
      catch: () => reject(400),
    })
    const json = yield* parseJson(text).pipe(Effect.mapError(() => reject(400)))
    let message: WebhookMessage
    if (event === "push") {
      message = yield* normalizePush(deliveryId, json).pipe(Effect.mapError(() => reject(422)))
    } else {
      message = yield* normalizePullRequest(deliveryId, json).pipe(
        Effect.mapError(() => reject(422)),
      )
    }

    const queue = yield* WebhookQueue
    yield* queue.send(message).pipe(Effect.mapError(() => reject(503)))
    return response(202)
  })

  return yield* program.pipe(
    Effect.matchCause({
      onFailure: (cause) =>
        Option.match(Cause.findErrorOption(cause), {
          onNone: () => response(500),
          onSome: ({ headers, status }) => response(status, headers),
        }),
      onSuccess: (result) => result,
    }),
  )
})
