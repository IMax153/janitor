import { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import { GitHubWebhookProjectionStatus } from "@janitor/domain/GitHub/WebhookJournal"
import { PayloadCipher } from "@janitor/webhooks/PayloadCipher"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { PROJECT_GITHUB_WEBHOOK_TAG } from "./ProjectWebhookRequest.ts"
import { GitHubWebhookJournal } from "./WebhookJournal.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"

export const ProjectGitHubWebhookPayload = Schema.Struct({
  deliveryId: GitHubWebhookDeliveryId,
})
export type ProjectGitHubWebhookPayload = typeof ProjectGitHubWebhookPayload.Type

export const ProjectGitHubWebhookResult = Schema.Struct({
  deliveryId: GitHubWebhookDeliveryId,
  status: GitHubWebhookProjectionStatus,
})
export type ProjectGitHubWebhookResult = typeof ProjectGitHubWebhookResult.Type

export class ProjectGitHubWebhookError extends Schema.TaggedError<ProjectGitHubWebhookError>()(
  "@janitor/cluster/GitHub/ProjectWebhook/ProjectGitHubWebhookError",
  {
    deliveryId: GitHubWebhookDeliveryId,
    message: Schema.String,
  },
) {}

export const ProjectGitHubWebhook = Workflow.make(PROJECT_GITHUB_WEBHOOK_TAG, {
  payload: ProjectGitHubWebhookPayload,
  success: ProjectGitHubWebhookResult,
  error: ProjectGitHubWebhookError,
  idempotencyKey: ({ deliveryId }) => deliveryId,
})

const parseJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)
const decodeEvent = Schema.decodeUnknownEffect(GitHubWebhookEvent)

/**
 * Decrypts and decodes one journaled delivery, then records the outcome.
 * Journal and cipher failures are typed workflow errors. Undecodable payloads
 * are recorded as `unsupported`, not failed, so repair can revisit them.
 */
export const projectDelivery = Effect.fn("ProjectGitHubWebhook.projectDelivery")(function* (
  deliveryId: GitHubWebhookDeliveryId,
) {
  const journal = yield* GitHubWebhookJournal
  const cipher = yield* PayloadCipher

  const fail = (message: string) => new ProjectGitHubWebhookError({ deliveryId, message })

  const delivery = yield* journal
    .load(deliveryId)
    .pipe(Effect.mapError((error) => fail(error.message)))
  if (Option.isNone(delivery)) {
    return yield* fail("Delivery is not journaled")
  }
  const row = delivery.value
  if (row.projectionStatus !== "pending") {
    return row.projectionStatus
  }

  const plaintext = yield* cipher
    .decrypt(deliveryId, row.encryption, row.payload)
    .pipe(Effect.result)
  if (Result.isFailure(plaintext)) {
    yield* journal
      .markProjection(deliveryId, "failed", Option.some("Payload decryption failed"))
      .pipe(Effect.mapError((error) => fail(error.message)))
    return "failed" as const
  }

  const decoded = yield* parseJson(new TextDecoder().decode(plaintext.success)).pipe(
    Effect.flatMap((payload) => decodeEvent({ id: deliveryId, name: row.eventName, payload })),
    Effect.result,
  )
  if (Result.isFailure(decoded)) {
    yield* journal
      .markProjection(deliveryId, "unsupported", Option.some(decoded.failure.message))
      .pipe(Effect.mapError((error) => fail(error.message)))
    return "unsupported" as const
  }

  yield* journal
    .markProjection(deliveryId, "projected", Option.none())
    .pipe(Effect.mapError((error) => fail(error.message)))
  return "projected" as const
})

export const ProjectGitHubWebhookLayer = ProjectGitHubWebhook.toLayer(
  Effect.fnUntraced(function* (payload) {
    const status = yield* Activity.make({
      name: "ProjectGitHubWebhook/Project",
      success: GitHubWebhookProjectionStatus,
      error: ProjectGitHubWebhookError,
      execute: projectDelivery(payload.deliveryId),
    })
    return { deliveryId: payload.deliveryId, status }
  }),
)

const decodePayload = Schema.decodeUnknownEffect(ProjectGitHubWebhookPayload)

export const ProjectGitHubWebhookRegistration: WorkflowRegistration = {
  tag: PROJECT_GITHUB_WEBHOOK_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => ProjectGitHubWebhook.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
