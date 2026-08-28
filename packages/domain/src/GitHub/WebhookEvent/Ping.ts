import * as Schema from "effect/Schema"
import { BaseGitHubWebhookEvent } from "./Base.ts"

export const GitHubWebhookHookId = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  identifier: "GitHubWebhookHookId",
})
export type GitHubWebhookHookId = typeof GitHubWebhookHookId.Type

export const PingWebhookPayload = Schema.Struct({
  hookId: GitHubWebhookHookId,
  zen: Schema.NonEmptyString,
})
  .pipe(Schema.encodeKeys({ hookId: "hook_id" }))
  .annotate({ identifier: "PingWebhookPayload" })
export type PingWebhookPayload = typeof PingWebhookPayload.Type

export const PingWebhookEvent = Schema.Struct({
  ...BaseGitHubWebhookEvent.fields,
  name: Schema.Literal("ping"),
  payload: PingWebhookPayload,
}).annotate({ identifier: "PingWebhookEvent" })
export type PingWebhookEvent = typeof PingWebhookEvent.Type
