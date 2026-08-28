import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export class EnqueueError extends Data.TaggedError("EnqueueError")<{
  readonly event: GitHubWebhookEvent
  readonly cause: unknown
}> {}

export class GitHubEventQueue extends Context.Service<
  GitHubEventQueue,
  {
    readonly enqueue: (event: GitHubWebhookEvent) => Effect.Effect<void, EnqueueError>
  }
>()("@janitor/webhooks/GitHub/EventQueue/GitHubEventQueue") {}

const make = Effect.gen(function* () {
  const resource = yield* Cloudflare.Queues.Queue("GitHubEventsQueue")
  const queue = yield* Cloudflare.Queues.WriteQueue(resource)

  const encodeWebhookEvent = Schema.encodeEffect(GitHubWebhookEvent)

  const enqueue = Effect.fn("GitHubEventQueue.enqueue")(
    function* (event: GitHubWebhookEvent) {
      const body = yield* encodeWebhookEvent(event)
      return yield* queue.send(body, { contentType: "json" })
    },
    (effect, event) => Effect.mapError(effect, (cause) => new EnqueueError({ event, cause })),
  )

  return {
    enqueue,
  }
})

export const layer = Layer.effect(GitHubEventQueue, make)
