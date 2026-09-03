import {
  ReconciliationIdentity,
  ReconciliationOutcome,
} from "@janitor/domain/Labeling/Reconciliation"
import { RulesetRevision } from "@janitor/domain/Labeling/Ruleset"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
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
})

/**
 * Reconciles one qualified snapshot (design: "Workflow activities"). This
 * slice loads and re-qualifies the snapshot and records the outcome; the
 * evaluation and plan activities follow.
 */
export const ReconcileEntity = Workflow.make(RECONCILE_ENTITY_TAG, {
  payload: ReconciliationIdentity,
  success: ReconcileEntityResult,
  error: ReconcileActivityError,
  idempotencyKey: (identity) =>
    `${identity.repositoryId}:${identity.number}:${identity.snapshotGeneration}:${identity.rulesRevision}`,
})

const QualifyResult = Schema.Union([
  Schema.TaggedStruct("Qualified", {}),
  Schema.TaggedStruct("Disqualified", {
    outcome: Schema.Literals(["superseded", "not-qualified"]),
    detail: Schema.String,
  }),
])

const ActiveRow = Schema.Struct({
  active_revision: Schema.NullOr(Schema.FiniteFromString.pipe(Schema.decodeTo(RulesetRevision))),
})

class QualifyFailure extends Data.TaggedError("QualifyFailure")<{ readonly message: string }> {}

const failure = (message: string) => new ReconcileActivityError({ message })

export const ReconcileEntityLayer = ReconcileEntity.toLayer(
  Effect.fnUntraced(function* (identity) {
    const { repositoryId, number } = identity

    const qualified = yield* Activity.make({
      name: "ReconcileEntity/Qualify",
      success: QualifyResult,
      error: ReconcileActivityError,
      execute: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const targets = yield* SyncTargets
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
        return { _tag: "Qualified" as const }
      }).pipe(Effect.mapError((error) => failure(error.message))),
    })

    const outcome =
      qualified._tag === "Qualified"
        ? { outcome: "evaluated" as const, detail: "no rules evaluated yet" }
        : { outcome: qualified.outcome, detail: qualified.detail }

    yield* Activity.make({
      name: `ReconcileEntity/Record/${outcome.outcome}`,
      error: ReconcileActivityError,
      execute: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          UPDATE labeling_reconciliation
          SET outcome = ${outcome.outcome}, detail = ${outcome.detail}, completed_at = CLOCK_TIMESTAMP()
          WHERE repository_id = ${repositoryId} AND number = ${number}
            AND snapshot_generation = ${identity.snapshotGeneration}
            AND rules_revision = ${identity.rulesRevision}
        `.pipe(Effect.mapError((error) => failure(describeError(error))))
        yield* Effect.logInfo("Reconciled entity snapshot").pipe(
          Effect.annotateLogs({ repositoryId, number, ...outcome }),
        )
      }),
    })

    return { ...identity, outcome: outcome.outcome }
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
