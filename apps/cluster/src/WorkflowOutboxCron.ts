import * as Effect from "effect/Effect"
import * as Singleton from "effect/unstable/cluster/Singleton"
import { WorkflowDispatcher } from "./WorkflowDispatcher.ts"

export const WorkflowOutboxCronName = "workflow-outbox-dispatch"

/** Woken by the Cron Trigger to recover due outbox rows that immediate dispatch missed. */
export const WorkflowOutboxCronLayer = Singleton.make(
  WorkflowOutboxCronName,
  Effect.gen(function* () {
    const dispatcher = yield* WorkflowDispatcher
    const summary = yield* dispatcher.dispatchDue({ limit: 100 })
    yield* Effect.logInfo("Dispatched due workflow outbox rows").pipe(
      Effect.annotateLogs({ ...summary }),
    )
  }).pipe(
    Effect.catchCause(
      Effect.fnUntraced(function* (cause) {
        yield* Effect.logError("Workflow outbox dispatch failed", cause)
      }),
    ),
  ),
)
