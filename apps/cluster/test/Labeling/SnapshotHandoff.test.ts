import { assert, layer } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import {
  GitHubAccountDatabaseId,
  GitHubCommitSha,
  GitHubInstallationId,
  GitHubLabelDatabaseId,
  GitHubLabelNodeId,
  GitHubPullRequestDatabaseId,
  GitHubPullRequestNodeId,
  GitHubRepositoryDatabaseId,
} from "@janitor/domain/GitHub/Id"
import { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import * as Schema from "effect/Schema"
import { type Rule, RuleId, RulesetRevision } from "@janitor/domain/Labeling/Ruleset"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { RulesetActivation } from "../../src/Labeling/Activation.ts"
import { LabelingOverview } from "../../src/Labeling/Overview.ts"
import { ReconcileEntity, ReconcileEntityLayer } from "../../src/Labeling/ReconcileEntity.ts"
import { LabelingRulesets } from "../../src/Labeling/Rulesets.ts"
import { RECONCILE_ENTITY_TAG, SnapshotHandoff } from "../../src/Labeling/SnapshotHandoff.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { WorkflowOutbox } from "../../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

const Services = Layer.mergeAll(
  SnapshotHandoff.layer,
  LabelingRulesets.layer,
  LabelingOverview.layer,
  ReconcileEntityLayer,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(SyncTargets.layer, GitHubReadModel.layer, RulesetActivation.layer),
  ),
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)

const installationId = GitHubInstallationId.make("77")
const repositoryId = GitHubRepositoryDatabaseId.make("701")
const bug = GitHubLabelDatabaseId.make("11")
const seq = GitHubWebhookJournalSequence.make("1")
const author = { issuer: "https://team.cloudflareaccess.test", subject: "user-1" }
const number = 5

const baseMain: Rule = {
  id: RuleId.make("base-main"),
  name: "Base is main",
  enabled: true,
  target: "pull_request",
  evaluator: { _tag: "Concrete", predicates: [{ _tag: "BaseBranchIs", ref: "main" }] },
  labels: [bug],
  onMatch: "add",
  onUnmatch: "remove-if-applied",
  dryRun: false,
}

const seed = Effect.gen(function* () {
  const readModel = yield* GitHubReadModel
  yield* readModel.applyInstallation({
    installation: {
      id: installationId,
      account: { id: GitHubAccountDatabaseId.make("1"), login: "effect", type: "Organization" },
      repositorySelection: "all",
      htmlUrl: "https://github.com/settings/installations/77",
      suspendedAt: null,
    },
    status: "active",
    sequence: seq,
  })
  yield* readModel.applyRepositories({
    installationId,
    repositories: [
      { id: repositoryId, fullName: { owner: "effect", repo: "one" }, isPrivate: false },
    ],
    sequence: seq,
  })
  yield* readModel.applyLabelCatalog({
    repositoryId,
    labels: [{ id: bug, nodeId: GitHubLabelNodeId.make("LA_bug"), name: "bug" }],
    sequence: seq,
  })
  const issue = yield* Schema.decodeUnknownEffect(GitHubIssueApi)({
    id: 1005,
    node_id: "I_5",
    number,
    title: "Trace",
    body: null,
    state: "open",
    user: { id: 9, login: "Octocat" },
    labels: [],
    updated_at: "2026-09-03T14:00:00Z",
    pull_request: { url: "https://api.github.com/x" },
  })
  yield* readModel.applyIssue({ repositoryId, sequence: seq, issue })
  yield* readModel.applyPullRequestDetails({
    repositoryId,
    sequence: seq,
    pullRequest: {
      id: GitHubPullRequestDatabaseId.make("2005"),
      nodeId: GitHubPullRequestNodeId.make("PR_5"),
      number,
      state: "open",
      draft: false,
      mergedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-09-03T14:00:00.000Z"),
      head: { sha: GitHubCommitSha.make("a".repeat(40)) },
      base: { ref: "main" },
    },
  })
})

/** Verifies the entity scope once and returns the verified generation. */
const verifyEntity = Effect.gen(function* () {
  const targets = yield* SyncTargets
  const scope = { _tag: "Entity", repositoryId, number } as const
  const { generation } = yield* targets.invalidate({ scope, sequence: Option.some(seq) })
  yield* targets.begin(scope, generation)
  yield* targets.complete({
    scope,
    generation,
    outcome: { _tag: "Verified", watermark: Option.none() },
  })
  return generation
})

const verifyTrack = (track: "labels" | "entities" | "pull_requests") =>
  Effect.gen(function* () {
    const targets = yield* SyncTargets
    const scope = { _tag: "RepositoryTrack", repositoryId, track } as const
    const record = Option.getOrThrow(yield* targets.get(scope))
    yield* targets.begin(scope, record.requestedGeneration)
    yield* targets.complete({
      scope,
      generation: record.requestedGeneration,
      outcome: { _tag: "Verified", watermark: Option.none() },
    })
  })

const outboxKeys = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ execution_key: string }>`
    SELECT execution_key FROM workflow_outbox WHERE workflow_tag = ${RECONCILE_ENTITY_TAG}
    ORDER BY execution_key
  `,
)

layer(Services, { timeout: "2 minutes" })("SnapshotHandoff against Postgres", (it) => {
  it.effect("skips without an active revision or a verified entity, then publishes once", () =>
    Effect.gen(function* () {
      yield* seed
      const handoff = yield* SnapshotHandoff
      const rulesets = yield* LabelingRulesets
      const activation = yield* RulesetActivation
      const overview = yield* LabelingOverview

      const generation = yield* verifyEntity
      const noRevision = yield* handoff.publish({ repositoryId, number, generation, sequence: seq })
      assert.deepStrictEqual(noRevision, { _tag: "Skipped", reason: "no-active-revision" })

      yield* rulesets.save({
        repositoryId,
        expectedRevision: RulesetRevision.make(0),
        ruleset: { rules: [baseMain], conflicts: "last-rule-wins" },
        author,
      })
      for (const track of ["labels", "entities", "pull_requests"] as const)
        yield* verifyTrack(track)
      assert.isTrue(Option.isSome(yield* activation.promote(repositoryId)))

      const unknown = yield* handoff.publish({
        repositoryId,
        number: 404,
        generation,
        sequence: seq,
      })
      assert.deepStrictEqual(unknown, { _tag: "Skipped", reason: "no-entity" })

      const published = yield* handoff.publish({ repositoryId, number, generation, sequence: seq })
      assert.strictEqual(published._tag, "Published")
      // A retried activity is a no-op on the same identity.
      const again = yield* handoff.publish({ repositoryId, number, generation, sequence: seq })
      assert.strictEqual(again._tag, "Published")
      assert.deepStrictEqual(
        (yield* outboxKeys).map((row) => row.execution_key),
        [`reconcile:${repositoryId}:${number}:${generation}:1`],
      )
      const pending = yield* overview.reconciliations(repositoryId)
      assert.strictEqual(pending.length, 1)
      assert.isNull(pending[0]?.outcome)
      assert.strictEqual(pending[0]?.fingerprint.length, 64)

      // The workflow re-qualifies the snapshot and records the outcome.
      const result = yield* ReconcileEntity.execute({
        repositoryId,
        number,
        snapshotGeneration: generation,
        rulesRevision: RulesetRevision.make(1),
      })
      assert.strictEqual(result.outcome, "evaluated")
      const done = yield* overview.reconciliations(repositoryId)
      assert.strictEqual(done[0]?.outcome, "evaluated")
      assert.strictEqual(done[0]?.detail, "1 change planned")
      // The tracer rule matches a pull request against main and plans the label.
      assert.deepStrictEqual(done[0]?.plan, {
        actions: [
          {
            labelId: bug,
            action: "add",
            ruleId: RuleId.make("base-main"),
            ruleName: "Base is main",
            dryRun: false,
          },
        ],
        matched: [RuleId.make("base-main")],
        conflicts: [],
      })
      assert.isNotNull(done[0]?.completedAt)

      // Resubmitting the same identity returns the stored result: first
      // payload wins, and a duplicate execution key never re-evaluates.
      const duplicate = yield* ReconcileEntity.execute({
        repositoryId,
        number,
        snapshotGeneration: generation,
        rulesRevision: RulesetRevision.make(1),
      })
      assert.strictEqual(duplicate.outcome, "evaluated")

      // A newer verified generation supersedes an identity built on the old one.
      const newer = yield* verifyEntity
      assert.notStrictEqual(newer, generation)
      const republished = yield* handoff.publish({
        repositoryId,
        number,
        generation: newer,
        sequence: seq,
      })
      assert.strictEqual(republished._tag, "Published")
      yield* verifyEntity
      const superseded = yield* ReconcileEntity.execute({
        repositoryId,
        number,
        snapshotGeneration: newer,
        rulesRevision: RulesetRevision.make(1),
      })
      assert.strictEqual(superseded.outcome, "superseded")

      const repositories = yield* overview.repositories
      assert.deepStrictEqual(
        repositories.map((row) => [row.repo, row.configuredRevision, row.activeRevision]),
        [["one", RulesetRevision.make(1), RulesetRevision.make(1)]],
      )
    }),
  )
})
