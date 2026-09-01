import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import { WorkflowEngine } from "effect/unstable/workflow"
import { TopologyProbe, TopologyProbeLayer } from "../src/TopologyProbe.ts"
import { TopologyProbeStore, type TopologyProbeCommitInput } from "../src/TopologyProbeStore.ts"

const makeTestLayer = (commits: Array<TopologyProbeCommitInput>) =>
  TopologyProbeLayer.pipe(
    Layer.provide(
      Layer.succeed(
        TopologyProbeStore,
        TopologyProbeStore.of({
          commit: (input) =>
            Effect.sync(() => {
              commits.push(input)
            }),
        }),
      ),
    ),
    Layer.provideMerge(WorkflowEngine.layerMemory),
  )

describe("TopologyProbe", () => {
  it.effect("derives a stable execution ID", () =>
    Effect.gen(function* () {
      const first = yield* TopologyProbe.executionId({
        executionKey: "probe-1",
      })
      const second = yield* TopologyProbe.executionId({
        executionKey: "probe-1",
      })
      const different = yield* TopologyProbe.executionId({
        executionKey: "probe-2",
      })

      assert.strictEqual(first, second)
      assert.notStrictEqual(first, different)
    }),
  )

  it.effect("reuses the result for an equivalent duplicate submission", () => {
    const commits: Array<TopologyProbeCommitInput> = []

    return Effect.gen(function* () {
      const fiber = yield* TopologyProbe.execute({
        executionKey: "probe-1",
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")

      const result = yield* Fiber.join(fiber)
      const duplicateResult = yield* TopologyProbe.execute({
        executionKey: "probe-1",
      })

      assert.deepStrictEqual(result, {
        executionKey: "probe-1",
        activityExecutionKey: "probe-1",
      })
      assert.deepStrictEqual(duplicateResult, result)
      assert.deepStrictEqual(commits, [
        {
          id: "probe-1",
          step: "first",
        },
      ])
    }).pipe(Effect.provide(makeTestLayer(commits)))
  })
})
