import { assert, describe, it } from "@effect/vitest"
import * as RuntimeContext from "alchemy/RuntimeContext"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import type { GitHubWebhookEnvelopeV1 } from "@janitor/domain/GitHub/WebhookEnvelope"
import { EnqueueError, GitHubEventQueue } from "@janitor/webhooks/GitHub/EventQueue"
import { GitHubWebhookRoutesLayer } from "@janitor/webhooks/GitHub/Http"
import { WebhookVerifier } from "@janitor/webhooks/WebhookVerifier"

const runtimeContext = RuntimeContext.RuntimeContext.of({
  Type: "Test",
  id: "test",
  env: {},
  get: <A>() => Effect.succeed<A | undefined>(undefined),
  set: (id) => Effect.succeed(id),
})

const validSignature = "sha256=" + "ab".repeat(32)

const VerifierStub = Layer.succeed(WebhookVerifier, {
  verify: (signature) => Effect.succeed(signature === validSignature),
})

const makeHandler = (
  enqueue: (envelope: GitHubWebhookEnvelopeV1) => Effect.Effect<void, EnqueueError>,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        GitHubWebhookRoutesLayer.pipe(
          Layer.provide([VerifierStub, Layer.succeed(GitHubEventQueue, { enqueue })]),
        ),
        {
          disableLogger: true,
          middleware: (app) =>
            app.pipe(
              Effect.orDie,
              Effect.provideService(RuntimeContext.RuntimeContext, runtimeContext),
            ),
        },
      ),
    ),
    ({ dispose }) => Effect.promise(dispose),
  ).pipe(Effect.map(({ handler }) => handler))

const post = (handler: (request: Request) => Promise<Response>, init: RequestInit) =>
  Effect.promise(() =>
    handler(new Request("https://example.com/webhooks/github", { method: "POST", ...init })),
  )

const headers = (overrides: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-hub-signature-256": validSignature,
  "x-github-delivery": "delivery-1",
  "x-github-event": "pull_request",
  ...overrides,
})

const sha256 = (bytes: Uint8Array<ArrayBuffer>) =>
  Effect.map(
    Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
    (digest) => Encoding.encodeHex(new Uint8Array(digest)),
  )

describe("GitHubWebhookRoutes", () => {
  it.effect("enqueues a versioned envelope with the exact payload bytes", () =>
    Effect.gen(function* () {
      const envelopes: Array<GitHubWebhookEnvelopeV1> = []
      const handler = yield* makeHandler((envelope) =>
        Effect.sync(() => void envelopes.push(envelope)),
      )
      const body = new TextEncoder().encode('{"action":"opened","number":1}')
      // The web handler runs in its own runtime with the real clock, not the test clock.
      const before = DateTime.toEpochMillis(DateTime.nowUnsafe())

      const response = yield* post(handler, { headers: headers(), body })

      const after = DateTime.toEpochMillis(DateTime.nowUnsafe())

      assert.strictEqual(response.status, 202)
      assert.strictEqual(envelopes.length, 1)
      const envelope = envelopes[0]
      assert.isDefined(envelope)
      if (envelope === undefined) return
      assert.strictEqual(envelope.schemaVersion, 1)
      assert.strictEqual(envelope.deliveryId, "delivery-1")
      assert.strictEqual(envelope.eventName, "pull_request")
      assert.strictEqual(envelope.payloadSha256, yield* sha256(body))
      assert.strictEqual(envelope.body._tag, "Inline")
      assert.deepStrictEqual(envelope.body.payload, body)
      const receivedAt = DateTime.toEpochMillis(envelope.receivedAt)
      assert.isTrue(receivedAt >= before && receivedAt <= after)
    }),
  )

  it.effect("acknowledges unsupported event names without enqueueing", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))

      const response = yield* post(handler, {
        headers: headers({ "x-github-event": "future_custom_event" }),
        body: '{"action":"something_new"}',
      })

      assert.strictEqual(response.status, 202)
      assert.strictEqual(calls, 0)
    }),
  )

  it.effect("enqueues unknown actions of supported events", () =>
    Effect.gen(function* () {
      const envelopes: Array<GitHubWebhookEnvelopeV1> = []
      const handler = yield* makeHandler((envelope) =>
        Effect.sync(() => void envelopes.push(envelope)),
      )

      const response = yield* post(handler, {
        headers: headers({ "x-github-event": "pull_request" }),
        body: '{"action":"action_the_schema_does_not_model"}',
      })

      assert.strictEqual(response.status, 202)
      assert.strictEqual(envelopes.length, 1)
      assert.strictEqual(envelopes[0]?.eventName, "pull_request")
    }),
  )

  it.effect("returns 503 and does not acknowledge when the queue write fails", () =>
    Effect.gen(function* () {
      const handler = yield* makeHandler((envelope) =>
        Effect.fail(
          new EnqueueError({ deliveryId: envelope.deliveryId, cause: new Error("down") }),
        ),
      )

      const response = yield* post(handler, { headers: headers(), body: "{}" })

      assert.strictEqual(response.status, 503)
      assert.strictEqual(response.headers.get("retry-after"), "60")
    }),
  )

  it.effect("rejects an invalid signature without enqueueing", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))

      const response = yield* post(handler, {
        headers: headers({ "x-hub-signature-256": "sha256=" + "00".repeat(32) }),
        body: "{}",
      })

      assert.strictEqual(response.status, 401)
      assert.strictEqual(calls, 0)
    }),
  )

  it.effect("rejects missing or empty GitHub headers with 400", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))

      const missing = yield* post(handler, {
        headers: { "x-hub-signature-256": validSignature, "x-github-event": "ping" },
        body: "{}",
      })
      const empty = yield* post(handler, {
        headers: headers({ "x-github-delivery": "" }),
        body: "{}",
      })

      assert.strictEqual(missing.status, 400)
      assert.strictEqual(empty.status, 400)
      assert.strictEqual(calls, 0)
    }),
  )

  it.effect("rejects a non-JSON body after signature verification", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))

      const response = yield* post(handler, { headers: headers(), body: "not json" })

      assert.strictEqual(response.status, 400)
      assert.strictEqual(calls, 0)
    }),
  )

  it.effect("rejects a declared oversized body with 413", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))

      const response = yield* post(handler, {
        headers: headers({ "content-length": String(1024 * 1024 + 1) }),
        body: "{}",
      })

      assert.strictEqual(response.status, 413)
      assert.strictEqual(calls, 0)
    }),
  )
})
