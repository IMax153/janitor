import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"
import type { WebhookMessage } from "./model.ts"

export class WebhookRateLimit extends Context.Service<
  WebhookRateLimit,
  {
    readonly limit: (key: string) => Effect.Effect<{ readonly success: boolean }, object>
  }
>()("janitor/webhook/WebhookRateLimit") {}

export class WebhookSecret extends Context.Service<WebhookSecret, Redacted.Redacted<string>>()(
  "janitor/webhook/WebhookSecret",
) {}

export class WebhookQueue extends Context.Service<
  WebhookQueue,
  {
    readonly send: (message: WebhookMessage) => Effect.Effect<void, object>
  }
>()("janitor/webhook/WebhookQueue") {}
