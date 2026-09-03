import {
  GitHubCheckRunsApi,
  GitHubIssueApi,
  GitHubPullRequestApi,
  GitHubPullRequestFileApi,
  GitHubPullRequestReviewApi,
} from "@janitor/domain/GitHub/Api"
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
import { LabelingConfiguration } from "../Labeling/Configuration.ts"
import { SnapshotHandoff } from "../Labeling/SnapshotHandoff.ts"
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

const Collections = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, status: Schema.String })),
  filesComplete: Schema.Boolean,
  checks: Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String })),
  reviews: Schema.Array(Schema.Struct({ reviewer: Schema.String, state: Schema.String })),
})

/** How many changed files one refresh reads before marking the listing incomplete. */
export const MAX_CHANGED_FILES = 300
const PAGE = 100

const FetchResult = Schema.Union([
  Schema.TaggedStruct("Found", {
    issue: GitHubIssueApi,
    pullRequest: Schema.NullOr(GitHubPullRequestApi),
    /** Fetched only when the configured revision reads a collection fact. */
    collections: Schema.NullOr(Collections),
  }),
  /** GitHub returned 404 or 403. Ambiguous: keep state and let inventory verify access. */
  Schema.TaggedStruct("Ambiguous", { status: Schema.Int }),
])

/** True when the configured revision reads any collection fact. Optional so sync tests run without labeling. */
const collectionsRequired = (repositoryId: GitHubRepositoryDatabaseId) =>
  Effect.serviceOption(LabelingConfiguration).pipe(
    Effect.flatMap((configuration) =>
      Option.isNone(configuration)
        ? Effect.succeed(false)
        : configuration.value.view(repositoryId).pipe(
            Effect.flatMap((view) =>
              view.configuredRevision === 0
                ? Effect.succeed(false)
                : configuration.value
                    .load(repositoryId, view.configuredRevision)
                    .pipe(
                      Effect.map(
                        (snapshot) =>
                          Option.isSome(snapshot) &&
                          snapshot.value.requiredTracks.some(
                            (track) =>
                              track === "changed_files" ||
                              track === "checks" ||
                              track === "reviews",
                          ),
                      ),
                    ),
            ),
            Effect.catch(() => Effect.succeed(false)),
          ),
    ),
  )

interface RefreshRequest {
  readonly scope: { readonly _tag: "Installation"; readonly installationId: GitHubInstallationId }
  readonly priority: "webhook-refresh"
}

const fetchCollections = (path: string, number: number, headSha: string, request: RefreshRequest) =>
  Effect.gen(function* () {
    const files: Array<{ path: string; status: string }> = []
    let filesComplete = true
    for (let page = 1; page <= MAX_CHANGED_FILES / PAGE; page++) {
      const listing = yield* fetchJson(
        {
          ...request,
          method: "GET",
          url: `${path}/pulls/${number}/files?per_page=${PAGE}&page=${page}`,
        },
        Schema.Array(GitHubPullRequestFileApi),
      )
      if (listing._tag === "Failed") return yield* failure(listing.message)
      for (const file of listing.body) files.push({ path: file.filename, status: file.status })
      if (listing.body.length < PAGE) break
      if (page === MAX_CHANGED_FILES / PAGE) filesComplete = false
    }
    const runs = yield* fetchJson(
      { ...request, method: "GET", url: `${path}/commits/${headSha}/check-runs?per_page=${PAGE}` },
      GitHubCheckRunsApi,
    )
    if (runs._tag === "Failed") return yield* failure(runs.message)
    const reviews = yield* fetchJson(
      { ...request, method: "GET", url: `${path}/pulls/${number}/reviews?per_page=${PAGE}` },
      Schema.Array(GitHubPullRequestReviewApi),
    )
    if (reviews._tag === "Failed") return yield* failure(reviews.message)
    // Latest decisive review per reviewer; a dismissal clears theirs.
    const latest = new Map<string, string>()
    for (const review of [...reviews.body].sort((left, right) => left.id - right.id)) {
      const reviewer = review.user?.login.toLowerCase()
      if (reviewer === undefined) continue
      if (review.state === "DISMISSED") latest.delete(reviewer)
      else if (review.state !== "COMMENTED" && review.state !== "PENDING") {
        latest.set(reviewer, review.state)
      }
    }
    return {
      files,
      filesComplete,
      checks: runs.body.checkRuns.map((run) => ({
        name: run.name,
        state: run.conclusion ?? run.status,
      })),
      reviews: [...latest].map(([reviewer, state]) => ({ reviewer, state })),
    }
  })

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
            return {
              _tag: "Found" as const,
              issue: issue.body,
              pullRequest: null,
              collections: null,
            }
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
          const collections = (yield* collectionsRequired(repositoryId))
            ? yield* fetchCollections(path, number, pull.body.head.sha, request)
            : null
          return { _tag: "Found" as const, issue: issue.body, pullRequest: pull.body, collections }
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
                if (found.collections !== null) {
                  yield* readModel.applyPullRequestCollections({
                    repositoryId,
                    number,
                    collections: found.collections,
                  })
                }
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
    // The verified snapshot is what auto-labeling evaluates. The handoff is
    // idempotent on its identity, so a retried activity publishes once.
    yield* Activity.make({
      name: "RefreshEntity/Handoff",
      error: SyncActivityError,
      execute: Effect.gen(function* () {
        const handoff = yield* Effect.serviceOption(SnapshotHandoff)
        if (Option.isNone(handoff)) return
        yield* handoff.value
          .publish({ repositoryId, number, generation, sequence })
          .pipe(Effect.mapError((error) => failure(error.message)))
      }),
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
