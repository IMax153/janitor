import {
  ReconciliationIdentity,
  ReconciliationOutcome,
} from "@janitor/domain/Labeling/Reconciliation"
import { type EntitySnapshot, evaluate, Plan } from "@janitor/domain/Labeling/Evaluation"
import { Ruleset, RulesetRevision } from "@janitor/domain/Labeling/Ruleset"
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
import { EVALUATION_MAX_AGE, RECONCILE_ENTITY_TAG } from "./SnapshotHandoff.ts"

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
 * and re-qualifies the snapshot, evaluates the revision's rules into a plan,
 * and records both. Applying the plan to GitHub is not wired yet.
 */
export const ReconcileEntity = Workflow.make(RECONCILE_ENTITY_TAG, {
  payload: ReconciliationIdentity,
  success: ReconcileEntityResult,
  error: ReconcileActivityError,
  idempotencyKey: (identity) =>
    `${identity.repositoryId}:${identity.number}:${identity.snapshotGeneration}:${identity.rulesRevision}`,
})

const QualifyResult = Schema.Union([
  Schema.TaggedStruct("Qualified", { plan: Plan }),
  Schema.TaggedStruct("Disqualified", {
    outcome: Schema.Literals(["superseded", "not-qualified"]),
    detail: Schema.String,
  }),
])

const ActiveRow = Schema.Struct({
  active_revision: Schema.NullOr(Schema.FiniteFromString.pipe(Schema.decodeTo(RulesetRevision))),
})

const RevisionRow = Schema.Struct({ ruleset: Ruleset })

const encodePlan = Schema.encodeEffect(Schema.fromJsonString(Plan))

const describePlan = (plan: Plan): string =>
  plan.actions.length === 0
    ? `no changes (${plan.matched.length} rule${plan.matched.length === 1 ? "" : "s"} matched)`
    : `${plan.actions.length} change${plan.actions.length === 1 ? "" : "s"} planned`

class QualifyFailure extends Data.TaggedError("QualifyFailure")<{ readonly message: string }> {}

const failure = (message: string) => new ReconcileActivityError({ message })

export const ReconcileEntityLayer = ReconcileEntity.toLayer(
  Effect.fnUntraced(function* (identity) {
    const { repositoryId, number } = identity

    const qualified = yield* Activity.make({
      name: "ReconcileEntity/Evaluate",
      success: QualifyResult,
      error: ReconcileActivityError,
      execute: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const targets = yield* SyncTargets
        const readModel = yield* GitHubReadModel
        const active = yield* sql`
          SELECT active_revision::text FROM labeling_repository_rules
          WHERE repository_id = ${repositoryId}
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ActiveRow))),
          Effect.mapError((error) => new QualifyFailure({ message: describeError(error) })),
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
          .pipe(Effect.mapError((error) => new QualifyFailure({ message: error.message })))
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

        const revision = yield* sql`
          SELECT ruleset FROM labeling_ruleset_revision
          WHERE repository_id = ${repositoryId} AND revision = ${identity.rulesRevision}
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RevisionRow))),
          Effect.mapError((error) => new QualifyFailure({ message: describeError(error) })),
        )
        const ruleset = revision[0]?.ruleset
        if (ruleset === undefined) {
          return yield* new QualifyFailure({
            message: `rules revision ${identity.rulesRevision} does not exist`,
          })
        }
        const entity = yield* readModel
          .getEntity(repositoryId, number)
          .pipe(Effect.mapError((error) => new QualifyFailure({ message: error.message })))
        if (Option.isNone(entity)) {
          return {
            _tag: "Disqualified" as const,
            outcome: "not-qualified" as const,
            detail: "entity is no longer in the read model",
          }
        }
        const { entity: record, pullRequest, labels } = entity.value
        const snapshot: EntitySnapshot = {
          kind: record.kind,
          title: record.title,
          authorLogin: record.authorLogin,
          state: record.state,
          baseRef: Option.map(pullRequest, (pr) => pr.baseRef).pipe(Option.getOrNull),
          draft: Option.map(pullRequest, (pr) => pr.draft).pipe(Option.getOrNull),
          labels: labels.map((label) => label.labelId),
        }
        // Nothing has been applied to GitHub yet, so no label is owned.
        const plan = evaluate({ ruleset, snapshot, applied: new Set() })
        return { _tag: "Qualified" as const, plan }
      }).pipe(Effect.mapError((error) => failure(error.message))),
    })

    const outcome =
      qualified._tag === "Qualified"
        ? {
            outcome: "evaluated" as const,
            detail: describePlan(qualified.plan),
            plan: qualified.plan,
          }
        : { outcome: qualified.outcome, detail: qualified.detail, plan: null }

    yield* Activity.make({
      name: `ReconcileEntity/Record/${outcome.outcome}`,
      error: ReconcileActivityError,
      execute: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const plan =
          outcome.plan === null
            ? null
            : yield* encodePlan(outcome.plan).pipe(
                Effect.mapError((error) => failure(describeError(error))),
              )
        yield* sql`
          UPDATE labeling_reconciliation
          SET outcome = ${outcome.outcome}, detail = ${outcome.detail},
              plan = ${plan}::jsonb, completed_at = CLOCK_TIMESTAMP()
          WHERE repository_id = ${repositoryId} AND number = ${number}
            AND snapshot_generation = ${identity.snapshotGeneration}
            AND rules_revision = ${identity.rulesRevision}
        `.pipe(Effect.mapError((error) => failure(describeError(error))))
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
