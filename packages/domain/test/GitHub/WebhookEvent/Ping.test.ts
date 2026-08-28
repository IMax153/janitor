import { describe, it } from "@effect/vitest"
import { TestSchema } from "effect/testing"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/WebhookEvent/Base"
import { PingWebhookPayload } from "@janitor/domain/GitHub/WebhookEvent/Ping"

describe("ping webhook schemas", () => {
  it("normalizes the hook ID", async () => {
    const decoding = new TestSchema.Asserts(PingWebhookPayload).decoding()

    await decoding.succeed(
      { hook_id: 123, zen: "Keep it logically awesome." },
      { hookId: 123, zen: "Keep it logically awesome." },
    )
    await decoding.fail(
      { hook_id: -1, zen: "Keep it logically awesome." },
      'Expected a value greater than 0\n  at ["hook_id"]',
    )
  })

  it("decodes through the aggregate event schema", async () => {
    const decoding = new TestSchema.Asserts(GitHubWebhookEvent).decoding()

    await decoding.succeed(
      {
        id: "delivery-789",
        name: "ping",
        payload: { hook_id: 123, zen: "Keep it logically awesome." },
      },
      {
        id: GitHubWebhookDeliveryId.make("delivery-789"),
        name: "ping",
        payload: { hookId: 123, zen: "Keep it logically awesome." },
      },
    )
  })
})
