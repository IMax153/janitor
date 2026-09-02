import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as DurableClock from "effect/unstable/workflow/DurableClock"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { TopologyProbeStore, TopologyProbeStoreError } from "./TopologyProbeStore.ts"

const GitHubRepositoryActivityName = "TopologyProbe/GitHub/GetRepository"
const PositiveDuration = Schema.DurationFromString.check(
  Schema.makeFilter((duration) => Duration.isFinite(duration) && Duration.isPositive(duration), {
    expected: "a finite positive duration",
  }),
)

export const TopologyProbePayload = Schema.Struct({
  executionKey: Schema.NonEmptyString,
  captureDefect: Schema.optionalKey(Schema.Boolean),
  firstClockDuration: Schema.optionalKey(PositiveDuration),
})
export type TopologyProbePayload = typeof TopologyProbePayload.Type

export const GitHubRepositoryProbeResult = Schema.Struct({
  id: Schema.String,
  nameWithOwner: Schema.String,
})

export const TopologyProbeResult = Schema.Struct({
  executionKey: Schema.String,
  activityExecutionKey: Schema.String,
  githubActivityIdempotencyKey: Schema.String,
  repository: GitHubRepositoryProbeResult,
})
export type TopologyProbeResult = typeof TopologyProbeResult.Type

export const TopologyProbe = Workflow.make("Janitor/TopologyProbeV1", {
  payload: TopologyProbePayload,
  success: TopologyProbeResult,
  error: TopologyProbeStoreError,
  idempotencyKey: ({ executionKey }) => executionKey,
})

export const TopologyProbeLayer = TopologyProbe.toLayer(
  Effect.fnUntraced(function* (payload) {
    const { executionKey } = payload
    const store = yield* TopologyProbeStore

    const activityExecutionKey = yield* Activity.make({
      name: "TopologyProbe/RecordExecution",
      success: Schema.String,
      error: TopologyProbeStoreError,
      execute: store.commit({ id: executionKey, step: "first" }).pipe(Effect.as(executionKey)),
    })

    if (payload.captureDefect === true) {
      return yield* Effect.die(new Error("Intentional topology probe defect"))
    }

    yield* DurableClock.sleep({
      name: `TopologyProbe/FirstClock`,
      duration: payload.firstClockDuration ?? "1 second",
    })

    yield* DurableClock.sleep({
      name: `TopologyProbe/SecondClock`,
      duration: "1 second",
    })

    const githubActivityIdempotencyKey = yield* Activity.idempotencyKey(
      GitHubRepositoryActivityName,
    )

    const repository = yield* Activity.make({
      name: GitHubRepositoryActivityName,
      success: GitHubRepositoryProbeResult,
      error: TopologyProbeStoreError,
      execute: store
        .commit({
          id: githubActivityIdempotencyKey,
          step: "second",
        })
        .pipe(
          Effect.as({
            id: "R_topology-probe",
            nameWithOwner: "effect-ts/effect",
          }),
        ),
    })

    return {
      executionKey,
      activityExecutionKey,
      githubActivityIdempotencyKey,
      repository,
    }
  }),
)
