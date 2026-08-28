import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as HttpServerError from "effect/unstable/http/HttpServerError"
import * as Url from "effect/unstable/http/Url"

export const MAX_GITHUB_WEBHOOK_BODY_BYTES = 1024 * 1024

const Headers = Schema.Struct({
  "content-length": Schema.optional(Schema.Int),
  "x-hub-signature-256": Schema.NonEmptyString,
  "x-github-delivery": Schema.NonEmptyString,
  "x-github-event": Schema.NonEmptyString,
})

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest

  const headers = yield* HttpServerRequest.schemaHeaders(Headers).pipe(Http)
})

export const GitHubWebHookLayer = HttpRouter.add("POST", "/api/v1/webhooks/github", handler)
