import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import { SyncGeneration, type SyncScope } from "@janitor/domain/GitHub/Sync"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { SyncTargets } from "../src/SyncTargets.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const TargetsLayer = SyncTargets.layer.pipe(
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(MigratedPostgresLayer),
)

const scope = (id: string): SyncScope => ({
  _tag: "InstallationInventory",
  installationId: GitHubInstallationId.make(id),
})
const seq = (n: number) => Option.some(GitHubWebhookJournalSequence.make(String(n)))
const gen = (n: number) => SyncGeneration.make(String(n))

const outboxRows = (key: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ execution_key: string; accepted_at: Date | null }>`
      SELECT execution_key, accepted_at FROM workflow_outbox
      WHERE execution_key LIKE ${`${key}:%`} ORDER BY execution_key
    `,
  )

layer(TargetsLayer, { timeout: "2 minutes" })("SyncTargets against Postgres", (it) => {
  it.effect("coalesces a burst of invalidations into one pending run", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const s = scope("1")

      const first = yield* targets.invalidate({ scope: s, sequence: seq(10) })
      const second = yield* targets.invalidate({ scope: s, sequence: seq(12) })
      const third = yield* targets.invalidate({ scope: s, sequence: seq(11) })

      assert.deepStrictEqual(first, { generation: gen(1), dispatched: true })
      assert.deepStrictEqual(second, { generation: gen(2), dispatched: false })
      assert.deepStrictEqual(third, { generation: gen(3), dispatched: false })
      assert.deepStrictEqual(
        (yield* outboxRows("installation:1")).map((row) => row.execution_key),
        ["installation:1:1"],
      )
      const target = Option.getOrThrow(yield* targets.get(s))
      assert.strictEqual(target.requestedGeneration, "3")
      assert.strictEqual(target.dispatchedGeneration, "1")
      assert.strictEqual(target.requestedSequence, "12")
    }),
  )

  it.effect("begin covers the latest generation and completion verifies it", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const s = scope("2")
      yield* targets.invalidate({ scope: s, sequence: seq(5) })
      yield* targets.invalidate({ scope: s, sequence: seq(7) })

      const begun = yield* targets.begin(s, gen(1))
      assert.deepStrictEqual(begun, {
        _tag: "Run",
        generation: gen(2),
        sequence: seq(7),
        watermark: Option.none(),
        full: false,
      })

      const followUp = yield* targets.complete({
        scope: s,
        generation: gen(2),
        outcome: { _tag: "Verified", watermark: Option.none() },
      })
      assert.isFalse(followUp)

      const target = Option.getOrThrow(yield* targets.get(s))
      assert.strictEqual(target.completedGeneration, "2")
      assert.strictEqual(target.verifiedGeneration, "2")
      assert.strictEqual(target.verifiedSequence, "7")
      assert.isNotNull(target.verifiedAt)
      assert.strictEqual(target.health, "ok")

      const stale = yield* targets.begin(s, gen(2))
      assert.deepStrictEqual(stale, { _tag: "Superseded" })
    }),
  )

  it.effect("work arriving during a run produces exactly one follow-up at completion", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const s = scope("3")
      yield* targets.invalidate({ scope: s, sequence: seq(1) })
      const begun = yield* targets.begin(s, gen(1))
      assert.strictEqual(begun._tag, "Run")

      const during = yield* targets.invalidate({ scope: s, sequence: seq(2) })
      const duringAgain = yield* targets.invalidate({ scope: s, sequence: seq(3) })
      assert.isFalse(during.dispatched)
      assert.isFalse(duringAgain.dispatched)

      const followUp = yield* targets.complete({
        scope: s,
        generation: gen(1),
        outcome: { _tag: "Verified", watermark: Option.none() },
      })
      assert.isTrue(followUp)
      assert.deepStrictEqual(
        (yield* outboxRows("installation:3")).map((row) => row.execution_key),
        ["installation:3:1", "installation:3:3"],
      )
      const target = Option.getOrThrow(yield* targets.get(s))
      assert.strictEqual(target.dispatchedGeneration, "3")
      assert.strictEqual(target.completedGeneration, "1")
    }),
  )

  it.effect("a run past the in-flight timeout no longer blocks dispatch", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const sql = yield* SqlClient.SqlClient
      const s = scope("9")
      yield* targets.invalidate({ scope: s, sequence: seq(1) })
      yield* targets.begin(s, gen(1))

      const fresh = yield* targets.invalidate({ scope: s, sequence: seq(2) })
      assert.isFalse(fresh.dispatched)

      yield* sql`
        UPDATE sync_target SET updated_at = CLOCK_TIMESTAMP() - INTERVAL '31 minutes'
        WHERE scope_key = 'installation:9'
      `
      const expired = yield* targets.invalidate({ scope: s, sequence: seq(3) })
      assert.deepStrictEqual(expired, { generation: gen(3), dispatched: true })
      assert.deepStrictEqual(
        (yield* outboxRows("installation:9")).map((row) => row.execution_key),
        ["installation:9:1", "installation:9:3"],
      )
    }),
  )

  it.effect("records blocked and failed outcomes without verifying", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const s = scope("4")
      yield* targets.invalidate({ scope: s, sequence: Option.none() })

      yield* targets.complete({
        scope: s,
        generation: gen(1),
        outcome: { _tag: "Blocked", reason: "suspended" },
      })
      let target = Option.getOrThrow(yield* targets.get(s))
      assert.strictEqual(target.health, "blocked")
      assert.strictEqual(target.blockedReason, "suspended")
      assert.strictEqual(target.verifiedGeneration, "0")

      yield* targets.invalidate({ scope: s, sequence: Option.none() })
      yield* targets.complete({
        scope: s,
        generation: gen(2),
        outcome: { _tag: "Failed", error: "boom" },
      })
      target = Option.getOrThrow(yield* targets.get(s))
      assert.strictEqual(target.health, "ok")
      assert.strictEqual(target.lastError, "boom")
      assert.strictEqual(target.completedGeneration, "2")
    }),
  )
})
