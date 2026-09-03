import { assert, layer } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
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
import { type Rule, RuleId, RulesetRevision } from "@janitor/domain/Labeling/Ruleset"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { RulesetActivation } from "../../src/Labeling/Activation.ts"
import { LabelingRulesets } from "../../src/Labeling/Rulesets.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { WorkflowOutbox } from "../../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

const RulesetsLayer = LabelingRulesets.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(SyncTargets.layer, GitHubReadModel.layer, RulesetActivation.layer),
  ),
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
})

const seedEntities = Effect.gen(function* () {
  const readModel = yield* GitHubReadModel
  for (const [number, base] of [
    [5, "main"],
    [6, "develop"],
  ] as const) {
    const issue = yield* Schema.decodeUnknownEffect(GitHubIssueApi)({
      id: 1000 + number,
      node_id: `I_${number}`,
      number,
      title: `Change ${number}`,
      body: null,
      state: "open",
      user: { id: 9, login: "octocat" },
      labels: [],
      updated_at: `2026-09-03T14:0${number}:00Z`,
      pull_request: { url: "https://api.github.com/x" },
    })
    yield* readModel.applyIssue({ repositoryId, sequence: seq, issue })
    yield* readModel.applyPullRequestDetails({
      repositoryId,
      sequence: seq,
      pullRequest: {
        id: GitHubPullRequestDatabaseId.make(String(2000 + number)),
        nodeId: GitHubPullRequestNodeId.make(`PR_${number}`),
        number,
        state: "open",
        draft: false,
        mergedAt: null,
        updatedAt: DateTime.makeUnsafe(`2026-09-03T14:0${number}:00.000Z`),
        head: { sha: GitHubCommitSha.make("a".repeat(40)) },
        base: { ref: base },
      },
    })
  }
})

layer(RulesetsLayer, { timeout: "2 minutes" })("LabelingRulesets against Postgres", (it) => {
  it.effect("previews a draft against recent open entities without saving", () =>
    Effect.gen(function* () {
      yield* seed
      yield* seedEntities
      const rulesets = yield* LabelingRulesets
      const preview = yield* rulesets.preview({
        repositoryId,
        ruleset: {
          rules: [
            baseMain,
            { ...baseMain, id: RuleId.make("bad"), labels: [GitHubLabelDatabaseId.make("404")] },
          ],
          conflicts: "last-rule-wins",
        },
      })
      assert.deepStrictEqual(
        preview.issues.map((issue) => [issue.ruleId, issue.code]),
        [["bad", "unresolved-label"]],
      )
      // Most recently updated first; only the pull request against main gets the label.
      assert.deepStrictEqual(
        preview.entities.map((entity) => [
          entity.number,
          entity.snapshot.baseRef,
          entity.plan.actions.map((action) => action.labelId),
        ]),
        [
          [6, "develop", []],
          [5, "main", [bug, GitHubLabelDatabaseId.make("404")]],
        ],
      )
      assert.strictEqual((yield* rulesets.load(repositoryId)).configuredRevision, 0)
    }),
  )

  it.effect("loads an empty ruleset with synchronized labels and 404s an unknown repository", () =>
    Effect.gen(function* () {
      yield* seed
      const rulesets = yield* LabelingRulesets
      const view = yield* rulesets.load(repositoryId)
      assert.strictEqual(view.configuredRevision, 0)
      assert.deepStrictEqual(view.configured, { rules: [], conflicts: "last-rule-wins" })
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
        ruleset: { rules: [baseMain], conflicts: "last-rule-wins" },
        author,
      })
      assert.strictEqual(first.configuredRevision, 1)
      assert.deepStrictEqual(first.configured.rules, [baseMain])
      // The save asked for every track the rule needs; none has verified yet.
      assert.isNull(first.activeRevision)
      assert.deepStrictEqual(first.pendingTracks, ["labels", "entities", "pull_requests"])

      // Editing revision 0 again is a conflict that reports the current state.
      const conflict = yield* Effect.flip(
        rulesets.save({
          repositoryId,
          expectedRevision: revision(0),
          ruleset: { rules: [], conflicts: "last-rule-wins" },
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
          ruleset: {
            rules: [
              {
                ...baseMain,
                labels: [GitHubLabelDatabaseId.make("404")],
              },
            ],
            conflicts: "last-rule-wins",
          },
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
        ruleset: { rules: [{ ...baseMain, enabled: false }], conflicts: "last-rule-wins" },
        author,
      })
      assert.strictEqual(second.configuredRevision, 2)
      assert.strictEqual(second.configured.rules[0]?.enabled, false)
      // A revision with no enabled rules needs nothing and is active at once.
      assert.strictEqual(second.activeRevision, 2)
      assert.deepStrictEqual(second.pendingTracks, [])
    }),
  )

  it.effect("promotes a revision once every track it recorded has verified", () =>
    Effect.gen(function* () {
      const rulesets = yield* LabelingRulesets
      const targets = yield* SyncTargets
      const activation = yield* RulesetActivation
      const saved = yield* rulesets.save({
        repositoryId,
        expectedRevision: revision(2),
        ruleset: { rules: [baseMain], conflicts: "last-rule-wins" },
        author,
      })
      assert.strictEqual(saved.configuredRevision, 3)
      assert.strictEqual(saved.activeRevision, 2)
      assert.deepStrictEqual(saved.pendingTracks, ["labels", "entities", "pull_requests"])

      const verify = (track: "labels" | "entities" | "pull_requests") =>
        Effect.gen(function* () {
          const scope = { _tag: "RepositoryTrack", repositoryId, track } as const
          const record = Option.getOrThrow(yield* targets.get(scope))
          yield* targets.begin(scope, record.requestedGeneration)
          yield* targets.complete({
            scope,
            generation: record.requestedGeneration,
            outcome: { _tag: "Verified", watermark: Option.none() },
          })
        })

      yield* verify("labels")
      yield* verify("entities")
      assert.isTrue(Option.isNone(yield* activation.promote(repositoryId)))
      const waiting = yield* rulesets.load(repositoryId)
      assert.strictEqual(waiting.activeRevision, 2)
      assert.deepStrictEqual(waiting.pendingTracks, ["pull_requests"])

      yield* verify("pull_requests")
      assert.deepStrictEqual(yield* activation.promote(repositoryId), Option.some(revision(3)))
      const active = yield* rulesets.load(repositoryId)
      assert.strictEqual(active.activeRevision, 3)
      assert.deepStrictEqual(active.pendingTracks, [])
      // Nothing left to promote.
      assert.strictEqual(yield* activation.promoteAll, 0)
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
