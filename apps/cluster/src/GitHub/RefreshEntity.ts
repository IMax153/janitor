import { GitHubIssueApi, GitHubPullRequestApi } from "@janitor/domain/GitHub/Api"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { SyncGeneration } from "@janitor/domain/GitHub/Sync"
import {
  GitHubWebhookJournalSequence,
  GitHubWebhookJournalSequenceZero,
} from "@janitor/domain/GitHub/WebhookJournal"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { REFRESH_ENTITY_TAG } from "../SyncRequests.ts"
import { SyncTargets } from "../SyncTargets.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { GitHubReadModel } from "./ReadModel.ts"
import {
  SyncActivityError,
  SyncActivityFailure,
  SyncRunOutcome,
  completeRun,
  failure,
  fetchJson,
  logWorkflowFailure,
  resolveRepository,
  withRateLimitWaits,
} from "./SyncSupport.ts"

export const RefreshEntityPayload = Schema.Struct({
  scope: Schema.TaggedStruct("Entity", {
    repositoryId: GitHubRepositoryDatabaseId,
    number: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  generation: SyncGeneration,
})
export type RefreshEntityPayload = typeof RefreshEntityPayload.Type

export const RefreshEntityResult = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int,
  generation: SyncGeneration,
  outcome: SyncRunOutcome,
})

/** Targeted refresh of one issue or pull request: the foreground verification path. */
export const RefreshEntity = Workflow.make(REFRESH_ENTITY_TAG, {
  payload: RefreshEntityPayload,
  success: RefreshEntityResult,
  error: SyncActivityError,
  idempotencyKey: ({ scope, generation }) => `${scope.repositoryId}:${scope.number}:${generation}`,
})

const BeginActivityResult = Schema.Union([
  Schema.TaggedStruct("Run", {
    generation: SyncGeneration,
    sequence: Schema.NullOr(GitHubWebhookJournalSequence),
    installationId: GitHubInstallationId,
    owner: Schema.String,
    repo: Schema.String,
  }),
  Schema.TaggedStruct("Blocked", { reason: Schema.String }),
  Schema.TaggedStruct("Superseded", {}),
])

const FetchResult = Schema.Union([
  Schema.TaggedStruct("Found", {
    issue: GitHubIssueApi,
    pullRequest: Schema.NullOr(GitHubPullRequestApi),
  }),
  /** GitHub returned 404 or 403. Ambiguous: keep state and let inventory verify access. */
  Schema.TaggedStruct("Ambiguous", { status: Schema.Int }),
])

export const RefreshEntityLayer = RefreshEntity.toLayer(
  Effect.fnUntraced(function* (payload) {
    const scope = payload.scope
    const { repositoryId, number } = scope
    const result = (generation: SyncGeneration, outcome: SyncRunOutcome) => ({
      repositoryId,
      number,
      generation,
      outcome,
    })

    const begun = yield* Activity.make({
      name: "RefreshEntity/Begin",
      success: BeginActivityResult,
      error: SyncActivityError,
      execute: Effect.gen(function* () {
        const targets = yield* SyncTargets
        const run = yield* targets
          .begin(scope, payload.generation)
          .pipe(Effect.mapError((error) => failure(error.message)))
        if (run._tag === "Superseded") {
          return { _tag: "Superseded" as const }
        }
        const repository = yield* resolveRepository(repositoryId)
        if (repository._tag === "Blocked") {
          return { _tag: "Blocked" as const, reason: repository.reason }
        }
        return {
          _tag: "Run" as const,
          generation: run.generation,
          sequence: Option.getOrNull(run.sequence),
          installationId: repository.repository.installationId,
          owner: repository.repository.owner,
          repo: repository.repository.repo,
        }
      }),
    })
    if (begun._tag === "Superseded") {
      return result(payload.generation, "superseded")
    }
    if (begun._tag === "Blocked") {
      yield* completeRun("RefreshEntity", scope, payload.generation, {
        _tag: "Blocked",
        reason: begun.reason,
      })
      return result(payload.generation, "blocked")
    }
    const { generation } = begun
    const sequence = begun.sequence ?? GitHubWebhookJournalSequenceZero
    const path = `/repos/${encodeURIComponent(begun.owner)}/${encodeURIComponent(begun.repo)}`
    const request = {
      scope: { _tag: "Installation" as const, installationId: begun.installationId },
      priority: "webhook-refresh" as const,
    }

    const fetched = yield* withRateLimitWaits("RefreshEntity/Fetch", (attempt) =>
      Activity.make({
        name: `RefreshEntity/Fetch/${attempt}`,
        success: FetchResult,
        error: SyncActivityFailure,
        execute: Effect.gen(function* () {
          const issue = yield* fetchJson(
            { ...request, method: "GET", url: `${path}/issues/${number}` },
            GitHubIssueApi,
          )
          if (issue._tag === "Failed") {
            return issue.status === 404 || issue.status === 403
              ? { _tag: "Ambiguous" as const, status: issue.status }
              : yield* failure(issue.message)
          }
          if (issue.body.pullRequest === undefined) {
            return { _tag: "Found" as const, issue: issue.body, pullRequest: null }
          }
          const pull = yield* fetchJson(
            { ...request, method: "GET", url: `${path}/pulls/${number}` },
            GitHubPullRequestApi,
          )
          if (pull._tag === "Failed") {
            return pull.status === 404 || pull.status === 403
              ? { _tag: "Ambiguous" as const, status: pull.status }
              : yield* failure(pull.message)
          }
          return { _tag: "Found" as const, issue: issue.body, pullRequest: pull.body }
        }),
      }),
    ).pipe(Effect.result)

    if (fetched._tag === "Failure") {
      yield* completeRun("RefreshEntity", scope, generation, {
        _tag: "Failed",
        error: fetched.failure.message,
      })
      return result(generation, "failed")
    }
    if (fetched.success._tag === "Ambiguous") {
      yield* completeRun("RefreshEntity", scope, generation, {
        _tag: "Blocked",
        reason: `entity-http-${fetched.success.status}`,
      })
      return result(generation, "blocked")
    }
    const found = fetched.success

    yield* Activity.make({
      name: "RefreshEntity/Apply",
      error: SyncActivityError,
      execute: Effect.gen(function* () {
        const readModel = yield* GitHubReadModel
        yield* readModel
          .withTransaction(
            Effect.gen(function* () {
              yield* readModel.applyIssue({ repositoryId, issue: found.issue, sequence })
              if (found.pullRequest !== null) {
                yield* readModel.applyPullRequestDetails({
                  repositoryId,
                  pullRequest: found.pullRequest,
                  sequence,
                })
              }
            }),
          )
          .pipe(Effect.mapError((error) => failure(error.message)))
      }),
    })
    yield* completeRun("RefreshEntity", scope, generation, {
      _tag: "Verified",
      watermark: Option.none(),
    })
    return result(generation, "verified")
  }, logWorkflowFailure("RefreshEntity")),
)

const decodePayload = Schema.decodeUnknownEffect(RefreshEntityPayload)

export const RefreshEntityRegistration: WorkflowRegistration = {
  tag: REFRESH_ENTITY_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => RefreshEntity.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
