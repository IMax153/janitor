import {
  ReconciliationIdentity,
  ReconciliationOutcome,
} from "@janitor/domain/Labeling/Reconciliation"
import { LabelingRevision } from "@janitor/domain/Labeling/Policy/Configuration"
import { evaluate, type Resolver } from "@janitor/domain/Labeling/Policy/Evaluate"
import { type Evaluation } from "@janitor/domain/Labeling/Policy/Program"
import { Plan, plan, RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { GitHubReadModel } from "../GitHub/ReadModel.ts"
import { describeError } from "../SqlErrors.ts"
import { freshnessOf } from "../SyncFreshness.ts"
import { SyncTargets } from "../SyncTargets.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { LabelingConfiguration } from "./Configuration.ts"
import { EVALUATION_MAX_AGE, RECONCILE_ENTITY_TAG } from "./SnapshotHandoff.ts"
import { entityFacts } from "./Test.ts"

export class ReconcileActivityError extends Schema.TaggedError<ReconcileActivityError>()(
  "ReconcileActivityError",
  { message: Schema.String },
) {}

export const ReconcileEntityResult = Schema.Struct({
  ...ReconciliationIdentity.fields,
  outcome: ReconciliationOutcome,
  plan: Schema.NullOr(Plan),
})

/**
 * Reconciles one qualified snapshot (design: "Workflow activities"): loads
 * and re-qualifies the snapshot, evaluates every rule of the configured
 * revision, plans, and records per-rule outcomes and per-label actions.
 * Applying the plan to GitHub is a later activity.
 */
export const ReconcileEntity = Workflow.make(RECONCILE_ENTITY_TAG, {
  payload: ReconciliationIdentity,
  success: ReconcileEntityResult,
  error: ReconcileActivityError,
  idempotencyKey: (identity) =>
    `${identity.repositoryId}:${identity.number}:${identity.snapshotGeneration}:${identity.rulesRevision}`,
})

const RuleEvaluationRecord = Schema.Struct({
  ruleId: RuleId,
  policyVersionId: Schema.String,
  evaluation: Schema.Struct({
    outcome: Schema.Literals(["match", "no-match", "unknown", "not-applicable"]),
    reason: Schema.String,
    trace: Schema.Unknown,
  }),
})

const EvaluateResult = Schema.Union([
  Schema.TaggedStruct("Evaluated", { plan: Plan, evaluations: Schema.Array(RuleEvaluationRecord) }),
  Schema.TaggedStruct("Disqualified", {
    outcome: Schema.Literals(["superseded", "not-qualified"]),
    detail: Schema.String,
  }),
])

const ActiveRow = Schema.Struct({
  active_revision: Schema.NullOr(Schema.FiniteFromString.pipe(Schema.decodeTo(LabelingRevision))),
})

class EvaluateFailure extends Data.TaggedError("EvaluateFailure")<{ readonly message: string }> {}

const failure = (message: string) => new ReconcileActivityError({ message })

const encodePlan = Schema.encodeEffect(Schema.fromJsonString(Plan))

const describePlan = (evaluated: Plan): string =>
  evaluated.actions.length === 0
    ? `no changes (${evaluated.rules.filter((rule) => rule.selected).length} of ${evaluated.rules.length} rules selected)`
    : `${evaluated.actions.length} change${evaluated.actions.length === 1 ? "" : "s"} planned`

export const ReconcileEntityLayer = ReconcileEntity.toLayer(
  Effect.fnUntraced(function* (identity) {
    const { repositoryId, number } = identity

    const evaluated = yield* Activity.make({
      name: "ReconcileEntity/Evaluate",
      success: EvaluateResult,
      error: ReconcileActivityError,
      execute: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const targets = yield* SyncTargets
        const readModel = yield* GitHubReadModel
        const configuration = yield* LabelingConfiguration
        const active = yield* sql`
          SELECT active_revision::text FROM labeling_repository_rules
          WHERE repository_id = ${repositoryId}
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ActiveRow))),
          Effect.mapError((error) => new EvaluateFailure({ message: describeError(error) })),
        )
        const activeRevision = active[0]?.active_revision ?? null
        if (activeRevision !== identity.rulesRevision) {
          return {
            _tag: "Disqualified" as const,
            outcome: "superseded" as const,
            detail: `rules revision ${identity.rulesRevision} is no longer active`,
          }
        }
        const target = yield* targets
          .get({ _tag: "Entity", repositoryId, number })
          .pipe(Effect.mapError((error) => new EvaluateFailure({ message: error.message })))
        if (
          Option.isSome(target) &&
          BigInt(target.value.verifiedGeneration) > BigInt(identity.snapshotGeneration)
        ) {
          return {
            _tag: "Disqualified" as const,
            outcome: "superseded" as const,
            detail: `snapshot generation ${target.value.verifiedGeneration} replaced ${identity.snapshotGeneration}`,
          }
        }
        const freshness = freshnessOf(target, yield* DateTime.now, EVALUATION_MAX_AGE)
        if (freshness !== "verified") {
          return {
            _tag: "Disqualified" as const,
            outcome: "not-qualified" as const,
            detail: `snapshot is ${freshness}`,
          }
        }
        const snapshot = yield* configuration
          .load(repositoryId, identity.rulesRevision)
          .pipe(Effect.mapError((error) => new EvaluateFailure({ message: error.message })))
        if (Option.isNone(snapshot)) {
          return yield* new EvaluateFailure({
            message: `configuration revision ${identity.rulesRevision} does not exist`,
          })
        }
        const entity = yield* readModel
          .getEntity(repositoryId, number)
          .pipe(Effect.mapError((error) => new EvaluateFailure({ message: error.message })))
        if (Option.isNone(entity)) {
          return {
            _tag: "Disqualified" as const,
            outcome: "not-qualified" as const,
            detail: "entity is no longer in the read model",
          }
        }
        const facts = entityFacts(entity.value)
        const versions = new Map(
          snapshot.value.versions.map((version) => [version.versionId, version]),
        )
        const byPolicy = new Map(
          snapshot.value.versions.map((version) => [version.policyId, version]),
        )
        const resolve: Resolver = (policyId) => byPolicy.get(policyId)
        const outcomes = new Map<RuleId, Evaluation["outcome"]>()
        const evaluations: Array<typeof RuleEvaluationRecord.Type> = []
        for (const rule of snapshot.value.rules) {
          const version = versions.get(rule.policyVersionId)
          const evaluation: Evaluation =
            version === undefined
              ? { outcome: "unknown", reason: "policy version is missing", trace: [] }
              : evaluate({ program: version.program, snapshot: facts, resolve })
          outcomes.set(rule.id, evaluation.outcome)
          evaluations.push({ ruleId: rule.id, policyVersionId: rule.policyVersionId, evaluation })
        }
        const planned = plan({
          rules: snapshot.value.rules,
          outcomes,
          currentLabels: new Set(entity.value.labels.map((label) => label.labelId)),
        })
        return { _tag: "Evaluated" as const, plan: planned, evaluations }
      }).pipe(Effect.mapError((error) => failure(error.message))),
    })

    const outcome =
      evaluated._tag === "Evaluated"
        ? {
            outcome: "evaluated" as const,
            detail: describePlan(evaluated.plan),
            plan: evaluated.plan,
          }
        : { outcome: evaluated.outcome, detail: evaluated.detail, plan: null }

    yield* Activity.make({
      name: `ReconcileEntity/Record/${outcome.outcome}`,
      error: ReconcileActivityError,
      execute: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const encoded =
          outcome.plan === null
            ? null
            : yield* encodePlan(outcome.plan).pipe(
                Effect.mapError((error) => failure(describeError(error))),
              )
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE labeling_reconciliation
                SET outcome = ${outcome.outcome}, detail = ${outcome.detail},
                    plan = ${encoded}::jsonb, completed_at = CLOCK_TIMESTAMP()
                WHERE repository_id = ${repositoryId} AND number = ${number}
                  AND snapshot_generation = ${identity.snapshotGeneration}
                  AND rules_revision = ${identity.rulesRevision}
              `
              if (evaluated._tag !== "Evaluated") return
              const selected = new Set(
                evaluated.plan.rules.filter((rule) => rule.selected).map((rule) => rule.ruleId),
              )
              for (const entry of evaluated.evaluations) {
                yield* sql`
                  INSERT INTO labeling_rule_evaluation
                    (repository_id, number, snapshot_generation, rules_revision, rule_id,
                     policy_version_id, outcome, selected, reason, trace)
                  VALUES (${repositoryId}, ${number}, ${identity.snapshotGeneration}, ${identity.rulesRevision},
                          ${entry.ruleId}, ${entry.policyVersionId}, ${entry.evaluation.outcome},
                          ${selected.has(entry.ruleId)}, ${entry.evaluation.reason},
                          ${JSON.stringify(entry.evaluation.trace)}::jsonb)
                  ON CONFLICT DO NOTHING
                `
              }
              for (const action of evaluated.plan.actions) {
                yield* sql`
                  INSERT INTO labeling_label_action
                    (repository_id, number, snapshot_generation, rules_revision, label_id, action, rule_id)
                  VALUES (${repositoryId}, ${number}, ${identity.snapshotGeneration}, ${identity.rulesRevision},
                          ${action.labelId}, ${action.action}, ${action.ruleId})
                  ON CONFLICT DO NOTHING
                `
              }
            }),
          )
          .pipe(Effect.mapError((error) => failure(describeError(error))))
        yield* Effect.logInfo("Reconciled entity snapshot").pipe(
          Effect.annotateLogs({
            repositoryId,
            number,
            outcome: outcome.outcome,
            detail: outcome.detail,
          }),
        )
      }),
    })

    return { ...identity, outcome: outcome.outcome, plan: outcome.plan }
  }),
)

const decodePayload = Schema.decodeUnknownEffect(ReconciliationIdentity)

export const ReconcileEntityRegistration: WorkflowRegistration = {
  tag: RECONCILE_ENTITY_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => ReconcileEntity.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
