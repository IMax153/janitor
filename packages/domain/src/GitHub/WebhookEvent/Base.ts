import * as Schema from "effect/Schema"

export const GitHubWebhookDeliveryId = Schema.NonEmptyString.pipe(
  Schema.brand("GitHubWebhookDeliveryId"),
).annotate({ identifier: "GitHubWebhookDeliveryId" })
export type GitHubWebhookDeliveryId = typeof GitHubWebhookDeliveryId.Type

export const BaseGitHubWebhookEvent = Schema.Struct({
  id: GitHubWebhookDeliveryId,
}).annotate({ identifier: "BaseGitHubWebhookEvent" })
export type BaseGitHubWebhookEvent = typeof BaseGitHubWebhookEvent.Type
