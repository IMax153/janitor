import { describe, it } from "@effect/vitest"
import { TestSchema } from "effect/testing"
import { BaseGitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent/Base"

describe("base GitHub webhook event schema", () => {
  it("uses its identifier in decoding errors", async () => {
    const decoding = new TestSchema.Asserts(BaseGitHubWebhookEvent).decoding()

    await decoding.fail(null, "Expected BaseGitHubWebhookEvent")
  })
})
