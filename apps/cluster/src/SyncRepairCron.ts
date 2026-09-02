import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Singleton from "effect/unstable/cluster/Singleton"
import { ContentPurge } from "./ContentPurge.ts"
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
