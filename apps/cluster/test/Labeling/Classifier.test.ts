import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import {
  AiClassifier,
  AiConsentService,
  ClassifierProvider,
  ClassifierProviderError,
} from "../../src/Labeling/Classifier.ts"
import { RulesetActivation } from "../../src/Labeling/Activation.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  bug,
  LabelingLayer,
  repositoryId,
  seed,
  seedPullRequests,
  verifyTrack,
} from "./support.ts"

/** Answers by title: bumps match, everything else does not; can be made to fail. */
let failing = false
let calls = 0
const ProviderStub = Layer.succeed(ClassifierProvider, {
  identity: { provider: "stub", model: "stub-1" },
  ask: (prompt) =>
    Effect.suspend(() => {
      calls++
      return failing
        ? Effect.fail(new ClassifierProviderError({ message: "down", cause: null }))
        : Effect.succeed({
            matches: prompt.includes("Change 5"),
            confidence: prompt.includes("Change 5") ? 0.95 : 0.6,
            reason: prompt.includes("Change 5") ? "looks like it" : "unsure",
          })
    }),
})

const Services = LabelingLayer.pipe(
  Layer.provideMerge(AiClassifier.layer),
  Layer.provideMerge(AiConsentService.layer),
  Layer.provideMerge(ProviderStub),
  Layer.provideMerge(MigratedPostgresLayer),
)

layer(Services, { timeout: "2 minutes" })("Classifier against Postgres", (it) => {
  it.effect("evaluates unknown without consent, then classifies under a lease and caches", () =>
    Effect.gen(function* () {
      yield* seed
      yield* seedPullRequests
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const consent = yield* AiConsentService
      const test = yield* LabelingTest
      const sql = yield* SqlClient.SqlClient

      const created = yield* policies.create(
        repositoryId,
        {
          name: "Is a change five",
          description: "",
          source: {
            target: "pull_request",
            classify: {
              prompt: "Is {{fact:title}} the fifth change?",
              evidence: ["title"],
              minimumConfidence: 0.9,
            },
          },
        },
        actor,
      )
      // The prompt must only name declared evidence.
      const bad = yield* Effect.flip(
        policies
          .validate(
            repositoryId,
            {
              target: "pull_request",
              classify: { prompt: "{{fact:body}}", evidence: ["title"], minimumConfidence: 0.8 },
            },
            Option.none(),
          )
          .pipe(
            Effect.flatMap((result) =>
              result._tag === "Invalid" ? Effect.fail(result) : Effect.succeed(result),
            ),
          ),
      )
      assert.include(bad.message, "not listed as evidence")
      const published = yield* policies.publish(repositoryId, created.policy.policyId, 1, actor)

      // Bound rules may only preserve on a miss.
      const rejected = yield* Effect.flip(
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
      assert.strictEqual(
        rejected._tag === "RuleInvalid" ? rejected.issues[0]?.code : rejected._tag,
        "classifier-preserve-only",
      )
      yield* rules.create(
        repositoryId,
        {
          labelId: bug,
          policyId: created.policy.policyId,
          onNoMatch: "preserve",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )

      // Without consent nothing is sent and every outcome is unknown.
      const before = yield* test.run(repositoryId, {
        subject: { _tag: "Policy", policyId: created.policy.policyId },
        numbers: [5, 6],
      })
      assert.deepStrictEqual(
        before._tag === "Evaluated"
          ? before.entities.map((entity) => entity.evaluation?.outcome)
          : before._tag,
        ["unknown", "unknown"],
      )
      assert.strictEqual(calls, 0)

      const enabled = yield* consent.set(repositoryId, true, actor)
      assert.strictEqual(enabled.state, "enabled")
      assert.strictEqual(enabled.model, "stub-1")
      const after = yield* test.run(repositoryId, {
        subject: { _tag: "Policy", policyId: created.policy.policyId },
        numbers: [5, 6],
      })
      assert.deepStrictEqual(
        after._tag === "Evaluated"
          ? after.entities.map((entity) => [entity.number, entity.evaluation?.outcome])
          : after._tag,
        [
          [5, "match"],
          [6, "unknown"],
        ],
      )
      assert.strictEqual(calls, 2)
      // Same evidence, same version: served from the decision cache.
      yield* test.run(repositoryId, {
        subject: { _tag: "Policy", policyId: created.policy.policyId },
        numbers: [5],
      })
      assert.strictEqual(calls, 2)
      const decisions = yield* sql<{ outcome: string; provider: string }>`
        SELECT outcome, provider FROM labeling_ai_decision WHERE repository_id = ${repositoryId} ORDER BY number
      `
      assert.deepStrictEqual(decisions, [
        { outcome: "match", provider: "stub" },
        { outcome: "unknown", provider: "stub" },
      ])
      const leases = yield* sql<{ released: boolean }>`
        SELECT released_at IS NOT NULL AS released FROM labeling_ai_lease WHERE repository_id = ${repositoryId}
      `
      assert.deepStrictEqual(
        leases.map((row) => row.released),
        [true, true],
      )

      // A provider failure is unknown, never a miss.
      failing = true
      const failed = yield* test.run(repositoryId, {
        subject: {
          _tag: "Draft",
          source: {
            target: "pull_request",
            classify: { prompt: "{{fact:title}}?", evidence: ["title"], minimumConfidence: 0.8 },
          },
        },
        numbers: [5],
      })
      assert.strictEqual(
        failed._tag === "Evaluated" ? failed.entities[0]?.evaluation?.outcome : failed._tag,
        "unknown",
      )
      failing = false

      // Revoking with no live lease disables at once; the configuration still evaluates.
      const revoked = yield* consent.set(repositoryId, false, actor)
      assert.strictEqual(revoked.state, "disabled")
      yield* verifyTrack("entities")
      const activation = yield* RulesetActivation
      yield* activation.promote(repositoryId)
      const configuration = yield* LabelingConfiguration
      assert.isNotNull((yield* configuration.view(repositoryId)).activeRevision)
      const whole = yield* test.run(repositoryId, {
        subject: { _tag: "Configuration" },
        numbers: [5],
      })
      // Cached match still applies; unknown for the rest would preserve.
      assert.deepStrictEqual(
        whole._tag === "Evaluated"
          ? whole.entities[0]?.plan?.actions.map((action) => action.action)
          : whole._tag,
        ["add"],
      )
      assert.strictEqual(published.published?.manifest.tracks[0], "entities")
    }),
  )
})
