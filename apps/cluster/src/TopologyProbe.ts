import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as DurableClock from "effect/unstable/workflow/DurableClock"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { TopologyProbeStore, TopologyProbeStoreError } from "./TopologyProbeStore.ts"

export const TopologyProbeResult = Schema.Struct({
  executionKey: Schema.String,
  activityExecutionKey: Schema.String,
})
export type TopologyProbeResult = typeof TopologyProbeResult.Type

export const TopologyProbe = Workflow.make("Janitor/TopologyProbeV1", {
  payload: { executionKey: Schema.String },
  success: TopologyProbeResult,
  error: TopologyProbeStoreError,
  idempotencyKey: ({ executionKey }) => executionKey,
})

export const TopologyProbeLayer = TopologyProbe.toLayer(
  Effect.fnUntraced(function* ({ executionKey }) {
    const store = yield* TopologyProbeStore

    const activityExecutionKey = yield* Activity.make({
      name: "TopologyProbe/RecordExecution",
      success: Schema.String,
      error: TopologyProbeStoreError,
      execute: store.commit({ id: executionKey, step: "first" }).pipe(Effect.as(executionKey)),
    })

    yield* DurableClock.sleep({
      name: `TopologyProbe/FirstClock`,
      duration: "1 second",
    })

    yield* DurableClock.sleep({
      name: `TopologyProbe/SecondClock`,
      duration: "1 second",
    })

    return {
      executionKey,
      activityExecutionKey,
    }
  }),
)
