import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as HttpServerError from "effect/unstable/http/HttpServerError"
import { constUndefined } from "effect/Function"
import * as WebhookVerifier from "../WebhookVerifier.ts"
import * as GitHubEventQueue from "./EventQueue.ts"

export const MAX_GITHUB_WEBHOOK_BODY_BYTES = 1024 * 1024

const GitHubHeaders = Schema.Struct({
  "content-length": Schema.optional(Schema.NumberFromString.check(Schema.isInt())),
  "x-hub-signature-256": Schema.NonEmptyString,
  "x-github-delivery": Schema.NonEmptyString,
  "x-github-event": Schema.NonEmptyString,
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

const GitHubWebhookVerifier = WebhookVerifier.layer({
  secret: Config.Redacted("GITHUB_WEBHOOK_SECRET"),
})

export const GitHubWebHookLayer = Layer.unwrap(
  Effect.gen(function* () {
    const queue = yield* GitHubEventQueue.GitHubEventQueue
    const verifier = yield* WebhookVerifier.WebhookVerifier

    const decodeWebhookEvent = Schema.decodeUnknownEffect(GitHubWebhookEvent)

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

        const body = yield* request.arrayBuffer.pipe(
          Effect.map((buffer) => new Uint8Array(buffer)),
          Effect.orElseSucceed(constUndefined),
        )

        if (body === undefined) {
          return payloadTooLargeResponse
        }

        const hasValidSignature = yield* verifier.verify(headers["x-hub-signature-256"], body)

        if (!hasValidSignature) {
          return invalidWebhookSignatureResponse
        }

        const payload = yield* Effect.orElseSucceed(
          Effect.try(() => JSON.parse(new TextDecoder().decode(body))),
          constUndefined,
        )

        if (payload === undefined) {
          return yield* new HttpServerError.RequestParseError({
            request,
            description: "Invalid JSON payload",
          })
        }

        const deliveryId = headers["x-github-delivery"]
        const eventName = headers["x-github-event"]
        const event = yield* decodeWebhookEvent({
          id: deliveryId,
          name: eventName,
          payload,
        }).pipe(
          Effect.catchCause(
            Effect.fnUntraced(function* (cause) {
              yield* Effect.logDebug(
                "Ignored GitHub webhook event with unsupported schema",
                cause,
              ).pipe(Effect.annotateLogs({ id: deliveryId, event: eventName }))
              return undefined
            }),
          ),
        )

        // Let GitHub know we received the event even if it did not parse successfully
        if (event === undefined) {
          return acceptedResponse
        }

        yield* queue.enqueue(event).pipe(
          Effect.catchCause(
            Effect.fnUntraced(function* (cause) {
              yield* Effect.logDebug("Failed to enqueue event", cause).pipe(
                Effect.annotateLogs({ id: deliveryId, event: eventName }),
              )
            }),
          ),
        )

        return acceptedResponse
      }),
    )
  }),
).pipe(Layer.provide([GitHubEventQueue.layer, GitHubWebhookVerifier]))
