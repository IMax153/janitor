import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { describe, expect, test } from "vite-plus/test"
import { handle } from "./handler.ts"
import { WebhookQueue, WebhookRateLimit, WebhookSecret } from "./services.ts"

const secret = Redacted.make("test-secret")

const push = {
  repository: { id: 1, full_name: "effect/janitor", ignored: true },
  sender: { id: 2, login: "octocat" },
  ref: "refs/heads/main",
  before: "0".repeat(40),
  after: "1".repeat(40),
  forced: false,
  ignored: true,
}

const pullRequest = {
  action: "closed",
  number: 42,
  repository: { id: 1, full_name: "effect/janitor" },
  sender: { id: 2, login: "octocat" },
  pull_request: {
    id: 3,
    head: { sha: "2".repeat(40) },
    base: { sha: "3".repeat(40) },
    draft: false,
    merged: true,
  },
}

const sign = async (body: Uint8Array) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Redacted.value(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array(body)))
  return `sha256=${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

const makeRequest = async (
  body: string | Uint8Array<ArrayBuffer>,
  options: {
    readonly event?: string
    readonly signature?: string
    readonly deliveryId?: string
    readonly method?: string
    readonly path?: string
    readonly contentLength?: string
  } = {},
) => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  const signature = options.signature ?? (await sign(bytes))
  const headers = new Headers({
    "x-github-delivery": options.deliveryId ?? "delivery-1",
    "x-github-event": options.event ?? "push",
    "x-hub-signature-256": signature,
  })
  if (options.contentLength !== undefined) {
    headers.set("content-length", options.contentLength)
  }
  const method = options.method ?? "POST"
  return HttpServerRequest.fromWeb(
    new Request(`https://example.com${options.path ?? "/webhooks/github"}`, {
      method,
      headers,
      ...(method === "POST" ? { body } : {}),
    }),
  ).modify({ remoteAddress: Option.some("203.0.113.1") })
}

const run = async (
  request: HttpServerRequest.HttpServerRequest,
  options: {
    readonly rateSuccess?: boolean
    readonly rateFails?: boolean
    readonly queueFails?: boolean
  } = {},
) => {
  const messages: Array<unknown> = []
  const rateKeys: Array<string> = []
  const response = await Effect.runPromise(
    handle(request).pipe(
      Effect.provideService(WebhookSecret, secret),
      Effect.provideService(
        WebhookRateLimit,
        WebhookRateLimit.of({
          limit: (key) => {
            rateKeys.push(key)
            return options.rateFails === true
              ? Effect.fail(new Error("rate limiter unavailable"))
              : Effect.succeed({ success: options.rateSuccess ?? true })
          },
        }),
      ),
      Effect.provideService(
        WebhookQueue,
        WebhookQueue.of({
          send: (message) =>
            options.queueFails === true
              ? Effect.fail(new Error("queue unavailable"))
              : Effect.sync(() => {
                  messages.push(message)
                }),
        }),
      ),
    ),
  )
  return { messages, rateKeys, response }
}

describe("GitHub webhook handler", () => {
  test("authenticates, validates, normalizes, and enqueues a push", async () => {
    const { messages, response } = await run(await makeRequest(JSON.stringify(push)))

    expect(response.status).toBe(202)
    expect(messages).toEqual([
      {
        version: 1,
        event: "push",
        deliveryId: "delivery-1",
        repository: { id: 1, fullName: "effect/janitor" },
        sender: { id: 2, login: "octocat" },
        ref: "refs/heads/main",
        before: "0".repeat(40),
        after: "1".repeat(40),
        forced: false,
      },
    ])
  })

  test("normalizes a pull request", async () => {
    const { messages, response } = await run(
      await makeRequest(JSON.stringify(pullRequest), { event: "pull_request" }),
    )

    expect(response.status).toBe(202)
    expect(messages[0]).toMatchObject({
      version: 1,
      event: "pull_request",
      deliveryId: "delivery-1",
      action: "closed",
      number: 42,
      pullRequest: {
        id: 3,
        headSha: "2".repeat(40),
        baseSha: "3".repeat(40),
        draft: false,
        merged: true,
      },
    })
  })

  test("returns deterministic routing and rate limit responses", async () => {
    const notFound = await run(await makeRequest("", { path: "/other" }))
    const withQuery = await run(
      await makeRequest(JSON.stringify(push), { path: "/webhooks/github?installation=123" }),
    )
    const method = await run(await makeRequest("", { method: "GET" }))
    const denied = await run(await makeRequest(""), { rateSuccess: false })

    expect(notFound.response.status).toBe(404)
    expect(withQuery.response.status).toBe(202)
    expect(method.response.status).toBe(405)
    expect(method.response.headers.allow).toBe("POST")
    expect(denied.response.status).toBe(429)
    expect(denied.response.headers["retry-after"]).toBe("60")
  })

  test("rejects malformed and mismatched signatures", async () => {
    const malformed = await run(await makeRequest("{}", { signature: "bad" }))
    const mismatch = await run(await makeRequest("{}", { signature: `sha256=${"0".repeat(64)}` }))

    expect(malformed.response.status).toBe(401)
    expect(mismatch.response.status).toBe(401)
  })

  test("verifies the exact raw request bytes", async () => {
    const body = JSON.stringify(push, undefined, 2)
    const signature = await sign(new TextEncoder().encode(body))
    const changedWhitespace = body.replace("{\n", "{ ")
    const result = await run(await makeRequest(changedWhitespace, { signature }))

    expect(result.response.status).toBe(401)
    expect(result.messages).toEqual([])
  })

  test("rejects bad JSON, invalid payloads, and oversized bodies", async () => {
    const badJson = await run(await makeRequest("{"))
    const invalid = await run(await makeRequest("{}"))
    const oversized = await run(await makeRequest("", { contentLength: String(1024 * 1024 + 1) }))
    const streamedOversized = await run(await makeRequest("x".repeat(1024 * 1024 + 1)))

    expect(badJson.response.status).toBe(400)
    expect(invalid.response.status).toBe(422)
    expect(oversized.response.status).toBe(413)
    expect(streamedOversized.response.status).toBe(413)
  })

  test("rejects invalid UTF-8", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(push))
    const login = new TextEncoder().encode("octocat")
    const loginOffset = bytes.findIndex((_, index) =>
      login.every((loginByte, loginIndex) => bytes[index + loginIndex] === loginByte),
    )
    bytes[loginOffset] = 0xff

    const result = await run(await makeRequest(bytes))

    expect(result.response.status).toBe(400)
    expect(result.messages).toEqual([])
  })

  test("accepts a body at the exact size limit", async () => {
    const emptyPadding = JSON.stringify({ ...push, padding: "" })
    const body = JSON.stringify({
      ...push,
      padding: "x".repeat(1024 * 1024 - emptyPadding.length),
    })
    const result = await run(await makeRequest(body))

    expect(new TextEncoder().encode(body).byteLength).toBe(1024 * 1024)
    expect(result.response.status).toBe(202)
  })

  test("acknowledges unsupported authenticated events without enqueueing", async () => {
    const { messages, response } = await run(await makeRequest("not json", { event: "issues" }))

    expect(response.status).toBe(204)
    expect(messages).toEqual([])
  })

  test("returns 503 when queue send fails", async () => {
    const { response } = await run(await makeRequest(JSON.stringify(push)), {
      queueFails: true,
    })

    expect(response.status).toBe(503)
  })

  test("uses the shared unknown key and maps rate limiter failures to 503", async () => {
    const request = (await makeRequest("{}")).modify({ remoteAddress: Option.none() })
    const result = await run(request, { rateFails: true })

    expect(result.rateKeys).toEqual(["unknown"])
    expect(result.response.status).toBe(503)
  })
})
