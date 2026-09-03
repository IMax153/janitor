import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { LabelingRevision } from "@janitor/domain/Labeling/Policy/Configuration"
import type { ProgramSource } from "@janitor/domain/Labeling/Policy/Program"
import { RulesetActivation } from "../../src/Labeling/Activation.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import {
  actor,
  baseMain,
  bug,
  repositoryId,
  seed,
  seedPullRequests,
  Services,
  verifyTrack,
} from "./support.ts"

layer(Services, { timeout: "2 minutes" })("Policies and rules against Postgres", (it) => {
  it.effect("creates, publishes, binds, and activates through the configuration revision", () =>
    Effect.gen(function* () {
      yield* seed
      yield* seedPullRequests
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const configuration = yield* LabelingConfiguration
      const activation = yield* RulesetActivation

      const empty = yield* configuration.view(repositoryId)
      assert.strictEqual(empty.configuredRevision, 0)
      assert.deepStrictEqual(
        empty.labels.map((label) => label.name),
        ["bug", "feature"],
      )

      // A draft is not live: nothing advances until it publishes.
      const created = yield* policies.create(
        repositoryId,
        { name: "Base is main", description: "", source: baseMain },
        actor,
      )
      assert.strictEqual(created.policy.version, 1)
      assert.isNull(created.published)
      assert.deepStrictEqual(created.draft, {
        target: "pull_request",
        matchesWhen: { fact: "baseRef", operator: "equals", value: "main", caseSensitive: false },
      })
      assert.strictEqual((yield* configuration.view(repositoryId)).configuredRevision, 0)

      // Binding an unpublished policy is rejected.
      const unpublished = yield* Effect.flip(
        rules.create(
          repositoryId,
          {
            labelId: bug,
            policyId: created.policy.policyId,
            onNoMatch: "ensure-absent",
            group: null,
            priority: 0,
            enabled: true,
          },
          actor,
        ),
      )
      assert.strictEqual(unpublished._tag, "RuleInvalid")

      const published = yield* policies.publish(repositoryId, created.policy.policyId, 1, actor)
      assert.strictEqual(published.published?.revision, 1)
      assert.deepStrictEqual(published.published?.manifest.tracks, ["pull_requests"])
      assert.isFalse(published.draftDiffers)
      // Publishing with no rules bound still advances, so the fence is monotonic.
      assert.strictEqual((yield* configuration.view(repositoryId)).configuredRevision, 1)

      // Publishing the same program again reuses the version.
      const again = yield* policies.publish(
        repositoryId,
        created.policy.policyId,
        published.policy.version,
        actor,
      )
      assert.strictEqual(again.published?.versionId, published.published?.versionId)

      const rule = yield* rules.create(
        repositoryId,
        {
          labelId: bug,
          policyId: created.policy.policyId,
          onNoMatch: "ensure-absent",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )
      const afterRule = yield* configuration.view(repositoryId)
      assert.strictEqual(afterRule.configuredRevision, 3)
      assert.deepStrictEqual(afterRule.pendingTracks, ["pull_requests"])
      // The publish with nothing bound needed no tracks, so it activated at once.
      assert.strictEqual(afterRule.activeRevision, 2)

      const snapshot = Option.getOrThrow(
        yield* configuration.load(repositoryId, LabelingRevision.make(3)),
      )
      assert.deepStrictEqual(
        snapshot.rules.map((entry) => [entry.id, entry.policyVersionId]),
        [[rule.id, published.published?.versionId]],
      )
      assert.strictEqual(snapshot.versions.length, 1)

      yield* verifyTrack("pull_requests")
      assert.isTrue(Option.isSome(yield* activation.promote(repositoryId)))
      assert.strictEqual((yield* configuration.view(repositoryId)).activeRevision, 3)

      // Every change is audited with the Access subject.
      const audit = yield* rules.audit(repositoryId)
      assert.deepStrictEqual(
        audit.map((entry) => [entry.subject._tag, entry.operation]).reverse(),
        [
          ["Policy", "create"],
          ["Policy", "publish"],
          ["Policy", "publish"],
          ["Rule", "create"],
        ],
      )
      assert.strictEqual(audit[0]?.actor.subject, "user-1")
    }),
  )

  it.effect("rejects bad programs, resolves references by name, and guards deletion", () =>
    Effect.gen(function* () {
      const policies = yield* Policies

      const invalid = yield* policies.validate(
        repositoryId,
        { target: "issue", matchesWhen: { fact: "draft", operator: "is", value: true } },
        Option.none(),
      )
      assert.strictEqual(invalid._tag, "Invalid")
      assert.include(invalid._tag === "Invalid" ? invalid.message : "", "does not exist for issue")

      const unknown = yield* policies.validate(
        repositoryId,
        { target: "pull_request", matchesWhen: { policy: "nope" } },
        Option.none(),
      )
      assert.strictEqual(unknown._tag, "Invalid")

      const referencing = yield* policies.create(
        repositoryId,
        {
          name: "Ready",
          description: "",
          source: {
            target: "pull_request",
            matchesWhen: {
              all: [{ policy: "base is main" }, { fact: "draft", operator: "is", value: false }],
            },
          },
        },
        actor,
      )
      assert.deepStrictEqual(
        "matchesWhen" in referencing.draft ? referencing.draft.matchesWhen : null,
        {
          all: [{ policy: "Base is main" }, { fact: "draft", operator: "is", value: false }],
        },
      )
      const publishedReferencing = yield* policies.publish(
        repositoryId,
        referencing.policy.policyId,
        1,
        actor,
      )
      const base = (yield* policies.list(repositoryId)).find(
        (policy) => policy.name === "Base is main",
      )!
      assert.deepStrictEqual(publishedReferencing.published?.manifest.references, [base.policyId])

      const duplicate = yield* Effect.flip(
        policies.create(repositoryId, { name: "ready", description: "", source: baseMain }, actor),
      )
      assert.strictEqual(duplicate._tag, "PolicyNameTaken")

      // Bound by a rule and referenced by a program: not deletable.
      const inUse = yield* Effect.flip(
        policies.remove(repositoryId, base.policyId, base.version, actor),
      )
      assert.strictEqual(inUse._tag, "PolicyInUse")
      if (inUse._tag === "PolicyInUse") {
        assert.strictEqual(inUse.rules, 1)
        assert.strictEqual(inUse.references, 1)
      }

      const stale = yield* Effect.flip(
        policies.save(repositoryId, base.policyId, { version: 1, description: "x" }, actor),
      )
      assert.strictEqual(stale._tag, "PolicyConflict")
    }),
  )

  it.effect("tests drafts, policies, and the configuration against open pull requests", () =>
    Effect.gen(function* () {
      const test = yield* LabelingTest
      const policies = yield* Policies
      const base = (yield* policies.list(repositoryId)).find(
        (policy) => policy.name === "Base is main",
      )!

      const draft = yield* test.run(repositoryId, {
        subject: {
          _tag: "Draft",
          source: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "develop" },
          },
        },
        numbers: [],
      })
      assert.strictEqual(draft._tag, "Evaluated")
      if (draft._tag !== "Evaluated") return
      assert.deepStrictEqual(
        draft.entities.map((entity) => [entity.number, entity.evaluation?.outcome]),
        [
          [6, "match"],
          [5, "no-match"],
        ],
      )

      const policy = yield* test.run(repositoryId, {
        subject: { _tag: "Policy", policyId: base.policyId },
        numbers: [5],
      })
      assert.strictEqual(
        policy._tag === "Evaluated" ? policy.entities[0]?.evaluation?.outcome : policy._tag,
        "match",
      )

      const configured = yield* test.run(repositoryId, {
        subject: { _tag: "Configuration" },
        numbers: [],
      })
      assert.strictEqual(configured._tag, "Evaluated")
      if (configured._tag !== "Evaluated") return
      assert.deepStrictEqual(
        configured.entities.map((entity) => [
          entity.number,
          entity.plan?.actions.map((action) => action.action),
        ]),
        [
          [6, []],
          [5, ["add"]],
        ],
      )
      const rejected = yield* test.run(repositoryId, {
        subject: {
          _tag: "Draft",
          source: { target: "pull_request", matchesWhen: { policy: "missing" } },
        },
        numbers: [],
      })
      assert.strictEqual(rejected._tag, "Rejected")

      // Collection facts are unknown until a refresh fetched them, then evaluate.
      const changeset: ProgramSource = {
        target: "pull_request",
        matchesWhen: {
          some: "changedFiles",
          where: { fact: "path", operator: "matchesGlob", value: ".changeset/*.md" },
        },
      }
      const unknown = yield* test.run(repositoryId, {
        subject: { _tag: "Draft", source: changeset },
        numbers: [5],
      })
      assert.strictEqual(
        unknown._tag === "Evaluated" ? unknown.entities[0]?.evaluation?.outcome : unknown._tag,
        "unknown",
      )
      const readModel = yield* GitHubReadModel
      yield* readModel.applyPullRequestCollections({
        repositoryId,
        number: 5,
        collections: {
          files: [
            { path: ".changeset/brave-owls.md", status: "added" },
            { path: "src/a.ts", status: "modified" },
          ],
          filesComplete: true,
          checks: [{ name: "ci", state: "success" }],
          reviews: [{ reviewer: "octocat", state: "APPROVED" }],
        },
      })
      const known = yield* test.run(repositoryId, {
        subject: { _tag: "Draft", source: changeset },
        numbers: [5],
      })
      assert.strictEqual(
        known._tag === "Evaluated" ? known.entities[0]?.evaluation?.outcome : known._tag,
        "match",
      )
      const reviewed = yield* test.run(repositoryId, {
        subject: {
          _tag: "Draft",
          source: {
            target: "pull_request",
            matchesWhen: {
              none: "reviews",
              where: { fact: "state", operator: "equals", value: "CHANGES_REQUESTED" },
            },
          },
        },
        numbers: [5],
      })
      assert.strictEqual(
        reviewed._tag === "Evaluated" ? reviewed.entities[0]?.evaluation?.outcome : reviewed._tag,
        "match",
      )
    }),
  )
})
