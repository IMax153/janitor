import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  GitHubAccountDatabaseId,
  GitHubInstallationId,
  GitHubLabelDatabaseId,
  GitHubLabelNodeId,
  GitHubRepositoryDatabaseId,
} from "@janitor/domain/GitHub/Id"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { type Rule, RuleId, RulesetRevision } from "@janitor/domain/Labeling/Ruleset"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { LabelingRulesets } from "../../src/Labeling/Rulesets.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { WorkflowOutbox } from "../../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

const RulesetsLayer = LabelingRulesets.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SyncTargets.layer, GitHubReadModel.layer)),
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(MigratedPostgresLayer),
)

const installationId = GitHubInstallationId.make("77")
const repositoryId = GitHubRepositoryDatabaseId.make("701")
const bug = GitHubLabelDatabaseId.make("11")
const seq = GitHubWebhookJournalSequence.make("1")
const author = { issuer: "https://team.cloudflareaccess.test", subject: "user-1" }
const revision = (value: number) => RulesetRevision.make(value)

const baseMain: Rule = {
  id: RuleId.make("base-main"),
  name: "Base is main",
  enabled: true,
  target: "pull_request",
  evaluator: { _tag: "Concrete", predicates: [{ _tag: "BaseBranchIs", ref: "main" }] },
  labels: [bug],
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
})

layer(RulesetsLayer, { timeout: "2 minutes" })("LabelingRulesets against Postgres", (it) => {
  it.effect("loads an empty ruleset with synchronized labels and 404s an unknown repository", () =>
    Effect.gen(function* () {
      yield* seed
      const rulesets = yield* LabelingRulesets
      const view = yield* rulesets.load(repositoryId)
      assert.strictEqual(view.configuredRevision, 0)
      assert.deepStrictEqual(view.configured, { rules: [] })
      assert.isNull(view.activeRevision)
      assert.deepStrictEqual(view.labels, [
        { labelId: bug, name: "bug", availability: "available" },
      ])
      // No labels track verification yet.
      assert.strictEqual(view.labelFreshness, "projected")

      const missing = yield* Effect.flip(rulesets.load(GitHubRepositoryDatabaseId.make("999")))
      assert.strictEqual(missing._tag, "RepositoryNotFound")
    }),
  )

  it.effect("saves revisions optimistically and rejects invalid rules", () =>
    Effect.gen(function* () {
      const rulesets = yield* LabelingRulesets
      const first = yield* rulesets.save({
        repositoryId,
        expectedRevision: revision(0),
        ruleset: { rules: [baseMain] },
        author,
      })
      assert.strictEqual(first.configuredRevision, 1)
      assert.deepStrictEqual(first.configured.rules, [baseMain])

      // Editing revision 0 again is a conflict that reports the current state.
      const conflict = yield* Effect.flip(
        rulesets.save({
          repositoryId,
          expectedRevision: revision(0),
          ruleset: { rules: [] },
          author,
        }),
      )
      assert.strictEqual(conflict._tag, "RulesetConflict")
      if (conflict._tag === "RulesetConflict") {
        assert.strictEqual(conflict.current.configuredRevision, 1)
        assert.deepStrictEqual(conflict.current.configured.rules, [baseMain])
      }

      // An unresolved label is rejected and nothing advances.
      const invalid = yield* Effect.flip(
        rulesets.save({
          repositoryId,
          expectedRevision: revision(1),
          ruleset: { rules: [{ ...baseMain, labels: [GitHubLabelDatabaseId.make("404")] }] },
          author,
        }),
      )
      assert.strictEqual(invalid._tag, "RulesetInvalid")
      if (invalid._tag === "RulesetInvalid") {
        assert.deepStrictEqual(
          invalid.issues.map((issue) => issue.code),
          ["unresolved-label"],
        )
      }
      assert.strictEqual((yield* rulesets.load(repositoryId)).configuredRevision, 1)

      // A valid follow-up advances to revision 2 and keeps revision 1 immutable.
      const second = yield* rulesets.save({
        repositoryId,
        expectedRevision: revision(1),
        ruleset: { rules: [{ ...baseMain, enabled: false }] },
        author,
      })
      assert.strictEqual(second.configuredRevision, 2)
      assert.strictEqual(second.configured.rules[0]?.enabled, false)
      assert.isNull(second.activeRevision)
    }),
  )

  it.effect("reports label freshness from the labels track", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const rulesets = yield* LabelingRulesets
      const scope = { _tag: "RepositoryTrack", repositoryId, track: "labels" } as const
      const { generation } = yield* targets.invalidate({ scope, sequence: Option.none() })
      assert.strictEqual((yield* rulesets.load(repositoryId)).labelFreshness, "syncing")
      yield* targets.begin(scope, generation)
      yield* targets.complete({
        scope,
        generation,
        outcome: { _tag: "Verified", watermark: Option.none() },
      })
      assert.strictEqual((yield* rulesets.load(repositoryId)).labelFreshness, "verified")
    }),
  )
})
