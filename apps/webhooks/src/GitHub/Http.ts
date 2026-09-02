import { GitHubWebhookEventName } from "@janitor/domain/GitHub/WebhookEvent"
import {
  GitHubWebhookName,
  GitHubWebhookEnvelopeV1,
  GitHubWebhookPayloadSha256,
} from "@janitor/domain/GitHub/WebhookEnvelope"
import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as HttpServerError from "effect/unstable/http/HttpServerError"
import { constFalse } from "effect/Function"
import * as WebhookVerifier from "../WebhookVerifier.ts"
import * as GitHubEventQueue from "./EventQueue.ts"
import { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import * as Encoding from "effect/Encoding"
import * as DateTime from "effect/DateTime"

export const MAX_GITHUB_WEBHOOK_BODY_BYTES = 1024 * 1024

const GitHubHeaders = Schema.Struct({
  "content-length": Schema.optional(Schema.FiniteFromString.check(Schema.isInt())),
  "x-hub-signature-256": Schema.NonEmptyString,
  "x-github-delivery": GitHubWebhookDeliveryId,
  "x-github-event": GitHubWebhookName,
})

const acceptedResponse = HttpServerResponse.text("Accepted", {
  status: 202,
})
const invalidWebhookSignatureResponse = HttpServerResponse.text("Invalid Webhook Signature", {
  status: 401,
})
const payloadTooLargeResponse = HttpServerResponse.text("Payload Too Large", {
  status: 413,
})
const serviceUnavailableResponse = HttpServerResponse.text("Service Unavailable", {
  status: 503,
  headers: { "Retry-After": "60" },
})

export class BodyTooLargeError extends Data.TaggedError("BodyTooLargeError")<{
  readonly maxBytes: number
}> {}

const GitHubWebhookVerifier = WebhookVerifier.layer({
  secret: Config.Redacted("GITHUB_WEBHOOK_SECRET"),
})

export const GitHubWebhookRoutesLayerNoDeps = Layer.unwrap(
  Effect.gen(function* () {
    const queue = yield* GitHubEventQueue.GitHubEventQueue
    const verifier = yield* WebhookVerifier.WebhookVerifier

    const parseJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)
    const isSupportedEventName = Schema.is(GitHubWebhookEventName)

    const sha256Hex = Effect.fnUntraced(function* (body: Uint8Array<ArrayBuffer>) {
      const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", body))
      return GitHubWebhookPayloadSha256.make(Encoding.encodeHex(new Uint8Array(digest)))
    })

    const readBodyBounded = Effect.fnUntraced(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const chunks: Array<Uint8Array> = []

      let total = 0
      yield* request.stream.pipe(
        Stream.runForEach(
          Effect.fnUntraced(function* (chunk) {
            total += chunk.byteLength

            if (total > MAX_GITHUB_WEBHOOK_BODY_BYTES) {
              return yield* new BodyTooLargeError({
                maxBytes: MAX_GITHUB_WEBHOOK_BODY_BYTES,
              })
            }

            chunks.push(chunk)
          }),
        ),
      )

      const body = new Uint8Array(total)

      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }

      return body
    })

    return HttpRouter.add(
      "POST",
      "/webhooks/github",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest

        const headers = yield* HttpServerRequest.schemaHeaders(GitHubHeaders).pipe(
          Effect.catch(
            Effect.fnUntraced(function* () {
              return yield* new HttpServerError.RequestParseError({
                request,
                description: "Missing required GitHub webhook headers",
              })
            }),
          ),
        )

        if (
          headers["content-length"] !== undefined &&
          headers["content-length"] > MAX_GITHUB_WEBHOOK_BODY_BYTES
        ) {
          return payloadTooLargeResponse
        }

        const body = yield* readBodyBounded(request).pipe(
          Effect.catchTags({
            BodyTooLargeError: () => Effect.undefined,
            HttpServerError: (cause) =>
              Effect.fail(
                new HttpServerError.RequestParseError({
                  cause,
                  request,
                  description: "Unable to read webhook body",
                }),
              ),
          }),
        )

        if (body === undefined) {
          return payloadTooLargeResponse
        }

        const hasValidSignature = yield* verifier.verify(headers["x-hub-signature-256"], body)

        if (!hasValidSignature) {
          return invalidWebhookSignatureResponse
        }

        const isJson = yield* parseJson(new TextDecoder().decode(body)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(constFalse),
        )

        if (!isJson) {
          return yield* new HttpServerError.RequestParseError({
            request,
            description: "Invalid JSON payload",
          })
        }

        const deliveryId = headers["x-github-delivery"]
        const eventName = headers["x-github-event"]

        if (!isSupportedEventName(eventName)) {
          yield* Effect.logDebug("Ignored GitHub webhook with unsupported event name").pipe(
            Effect.annotateLogs({ id: deliveryId, event: eventName }),
          )
          return acceptedResponse
        }

        const envelope: GitHubWebhookEnvelopeV1 = {
          schemaVersion: 1,
          deliveryId,
          eventName,
          receivedAt: yield* DateTime.now,
          payloadSha256: yield* sha256Hex(body),
          body: { _tag: "Inline", payload: body },
        }

        const enqueued = yield* queue.enqueue(envelope).pipe(
          Effect.as(true),
          Effect.catchCause(
            Effect.fnUntraced(function* (cause) {
              yield* Effect.logError("Failed to enqueue GitHub webhook envelope", cause).pipe(
                Effect.annotateLogs({ id: deliveryId, event: eventName }),
              )
              return false
            }),
          ),
        )

        return enqueued ? acceptedResponse : serviceUnavailableResponse
      }),
    )
  }),
)

export const GitHubWebHookRoutesLayer = GitHubWebhookRoutesLayerNoDeps.pipe(
  Layer.provide([GitHubEventQueue.layer, GitHubWebhookVerifier]),
)
