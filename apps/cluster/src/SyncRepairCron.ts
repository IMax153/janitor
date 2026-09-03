import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Singleton from "effect/unstable/cluster/Singleton"
import { ContentPurge } from "./ContentPurge.ts"
import { RulesetActivation } from "./Labeling/Activation.ts"
import { AiConsentService } from "./Labeling/Classifier.ts"
import { backfillAfterActivation } from "./Labeling/SnapshotHandoff.ts"
import { REPAIR_PLANNER_NAME, SyncPlanner } from "./SyncPlanner.ts"

export const SyncRepairCronName = REPAIR_PLANNER_NAME

/** Woken by the Cron Trigger; creates overdue repair generations and nothing else. */
export const SyncRepairCronLayer = Singleton.make(
  SyncRepairCronName,
  Effect.gen(function* () {
    const planner = yield* SyncPlanner
    const now = yield* DateTime.now
    const summary = yield* planner.plan(now)
    if (summary.planned) {
      yield* Effect.logInfo("Planned GitHub sync repairs").pipe(Effect.annotateLogs({ ...summary }))
    }
    // Recovery for promotions whose post-verification attempt was lost.
    const activation = yield* RulesetActivation
    const promoted = yield* activation.promoteAll
    yield* Effect.forEach(promoted, backfillAfterActivation, { discard: true })
    // Revoked AI consent finishes draining once its leases are gone.
    const consent = yield* Effect.serviceOption(AiConsentService)
    if (Option.isSome(consent)) {
      const settled = yield* consent.value.settleDraining.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("AI consent settling failed", cause).pipe(Effect.as(0)),
        ),
      )
      if (settled > 0) {
        yield* Effect.logInfo("Disabled drained AI consent").pipe(Effect.annotateLogs({ settled }))
      }
    }
    const purge = yield* ContentPurge
    const purged = yield* purge.runDue(now)
    if (purged.purged > 0) {
      yield* Effect.logInfo("Purged private content after access loss").pipe(
        Effect.annotateLogs({ ...purged }),
      )
    }
  }).pipe(
    Effect.catchCause(
      Effect.fnUntraced(function* (cause) {
        yield* Effect.logError("GitHub sync repair planning failed", cause)
      }),
    ),
  ),
)
