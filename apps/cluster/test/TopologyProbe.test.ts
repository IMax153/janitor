import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { WorkflowEngine } from "effect/unstable/workflow"
import { TopologyProbe, TopologyProbeLayer, TopologyProbePayload } from "../src/TopologyProbe.ts"
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

  it.effect("decodes a finite positive first clock duration", () =>
    Effect.gen(function* () {
      const payload = yield* Schema.decodeUnknownEffect(TopologyProbePayload)({
        executionKey: "probe-1",
        firstClockDuration: "1 minute",
      })

      if (payload.firstClockDuration === undefined) {
        return assert.fail("Expected a decoded first clock duration")
      }
      assert.strictEqual(Duration.toMillis(payload.firstClockDuration), 60_000)

      for (const firstClockDuration of ["0 seconds", "-1 second", "Infinity"]) {
        const exit = yield* Schema.decodeUnknownEffect(TopologyProbePayload)({
          executionKey: "probe-1",
          firstClockDuration,
        }).pipe(Effect.exit)

        assert.isTrue(Exit.isFailure(exit))
      }
    }),
  )

  it.effect("uses a custom first clock duration", () => {
    const commits: Array<TopologyProbeCommitInput> = []

    return Effect.gen(function* () {
      const fiber = yield* TopologyProbe.execute({
        executionKey: "probe-custom-clock",
        firstClockDuration: Duration.minutes(1),
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Effect.yieldNow
      yield* TestClock.adjust("59 seconds")
      yield* Effect.yieldNow

      assert.deepStrictEqual(
        commits.map(({ step }) => step),
        ["first"],
      )

      yield* TestClock.adjust("1 second")
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")

      const result = yield* Fiber.join(fiber)
      assert.strictEqual(result.executionKey, "probe-custom-clock")
      assert.deepStrictEqual(
        commits.map(({ step }) => step),
        ["first", "second"],
      )
    }).pipe(Effect.provide(makeTestLayer(commits)))
  })

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

      assert.strictEqual(result.executionKey, "probe-1")
      assert.strictEqual(result.activityExecutionKey, "probe-1")
      assert.deepStrictEqual(result.repository, {
        id: "R_topology-probe",
        nameWithOwner: "effect-ts/effect",
      })
      assert.deepStrictEqual(duplicateResult, result)
      assert.deepStrictEqual(commits, [
        {
          id: "probe-1",
          step: "first",
        },
        {
          id: result.githubActivityIdempotencyKey,
          step: "second",
        },
      ])
    }).pipe(Effect.provide(makeTestLayer(commits)))
  })

  it.effect("captures a defect and completes remediation under a new execution key", () => {
    const commits: Array<TopologyProbeCommitInput> = []

    return Effect.gen(function* () {
      const defect = yield* TopologyProbe.execute({
        executionKey: "probe-defect",
        captureDefect: true,
      }).pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(defect))
      if (Exit.isFailure(defect)) {
        assert.isTrue(Cause.hasDies(defect.cause))
      }

      const remediation = yield* TopologyProbe.execute({
        executionKey: "probe-remediation",
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")

      const result = yield* Fiber.join(remediation)

      assert.strictEqual(result.executionKey, "probe-remediation")
      assert.deepStrictEqual(
        commits.map(({ step }) => step),
        ["first", "first", "second"],
      )
    }).pipe(Effect.provide(makeTestLayer(commits)))
  })
})
