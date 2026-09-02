import {
  SyncGeneration,
  SyncGenerationFromStringOrNumber,
  SyncScope,
  type SyncTargetRecord,
  syncScopeKey,
} from "@janitor/domain/GitHub/Sync"
import {
  GitHubWebhookJournalSequence,
  GitHubWebhookJournalSequenceFromStringOrNumber,
} from "@janitor/domain/GitHub/WebhookJournal"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "./SqlErrors.ts"
import { syncRequest } from "./SyncRequests.ts"
import { WorkflowOutbox } from "./WorkflowOutbox.ts"

export class SyncTargetError extends Schema.TaggedError<SyncTargetError>()(
  "@janitor/cluster/SyncTargets/SyncTargetError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

/** How long a burst of invalidations waits before its first sync starts. */
export const SYNC_DEBOUNCE = Duration.seconds(5)

export interface InvalidateRequest {
  readonly scope: SyncScope
  /** Highest journal sequence that motivated this invalidation, if any. */
  readonly sequence: Option.Option<GitHubWebhookJournalSequence>
  /** Ask the next run to ignore its watermark and scan from scratch. */
  readonly full?: boolean | undefined
}

export interface InvalidateResult {
  readonly generation: SyncGeneration
  /** True when this call created the outbox request; false when a run already covers it. */
  readonly dispatched: boolean
}

export type BeginResult =
  | {
      readonly _tag: "Run"
      /** The generation this run covers: the latest requested at begin time. */
      readonly generation: SyncGeneration
      readonly sequence: Option.Option<GitHubWebhookJournalSequence>
      /** Cutoff committed by the last complete incremental scan, if any. */
      readonly watermark: Option.Option<DateTime.Utc>
      /** True when a full repair was requested; the run must not rely on the watermark. */
      readonly full: boolean
    }
  | { readonly _tag: "Superseded" }

export type SyncOutcome =
  | { readonly _tag: "Verified"; readonly watermark: Option.Option<DateTime.Utc> }
  | { readonly _tag: "Blocked"; readonly reason: string }
  | { readonly _tag: "Failed"; readonly error: string }

export interface CompleteRequest {
  readonly scope: SyncScope
  readonly generation: SyncGeneration
  readonly outcome: SyncOutcome
}

const TargetRow = Schema.Struct({
  scope_key: Schema.String,
  scope: SyncScope,
  requested_generation: SyncGenerationFromStringOrNumber,
  dispatched_generation: SyncGenerationFromStringOrNumber,
  completed_generation: SyncGenerationFromStringOrNumber,
  verified_generation: SyncGenerationFromStringOrNumber,
  requested_sequence: Schema.NullOr(GitHubWebhookJournalSequenceFromStringOrNumber),
  verified_sequence: Schema.NullOr(GitHubWebhookJournalSequenceFromStringOrNumber),
  verified_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
  health: Schema.Literals(["ok", "blocked"]),
  blocked_reason: Schema.NullOr(Schema.String),
  last_error: Schema.NullOr(Schema.String),
  scan_watermark: Schema.NullOr(Schema.DateTimeUtcFromDate),
  full_requested: Schema.Boolean,
})

const toRecord = (row: typeof TargetRow.Type): SyncTargetRecord => ({
  scopeKey: row.scope_key,
  scope: row.scope,
  requestedGeneration: row.requested_generation,
  dispatchedGeneration: row.dispatched_generation,
  completedGeneration: row.completed_generation,
  verifiedGeneration: row.verified_generation,
  requestedSequence: row.requested_sequence,
  verifiedSequence: row.verified_sequence,
  verifiedAt: row.verified_at,
  health: row.health,
  blockedReason: row.blocked_reason,
  lastError: row.last_error,
})

const gt = (a: SyncGeneration, b: SyncGeneration) => BigInt(a) > BigInt(b)

/**
 * SQL-owned coalescing. Invalidations bump one counter per scope and create
 * at most one pending run; work that arrives during a run yields exactly one
 * follow-up at completion via compare-and-set.
 */
export class SyncTargets extends Context.Service<
  SyncTargets,
  {
    /** Joins the caller's transaction. */
    readonly invalidate: (
      request: InvalidateRequest,
    ) => Effect.Effect<InvalidateResult, SyncTargetError>
    readonly begin: (
      scope: SyncScope,
      generation: SyncGeneration,
    ) => Effect.Effect<BeginResult, SyncTargetError>
    /** Joins the caller's transaction. Returns true when a follow-up run was requested. */
    readonly complete: (request: CompleteRequest) => Effect.Effect<boolean, SyncTargetError>
    readonly get: (
      scope: SyncScope,
    ) => Effect.Effect<Option.Option<SyncTargetRecord>, SyncTargetError>
  }
>()("@janitor/cluster/SyncTargets/SyncTargets", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const outbox = yield* WorkflowOutbox
    const decodeRows = Schema.decodeUnknownEffect(Schema.Array(TargetRow))
    const encodeScope = Schema.encodeEffect(Schema.fromJsonString(SyncScope))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new SyncTargetError({ operation, message: describeError(error) }),
        )

    const enqueueRun = (scope: SyncScope, generation: SyncGeneration) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const dueAt = DateTime.toDateUtc(DateTime.addDuration(now, SYNC_DEBOUNCE))
        const request = syncRequest(scope, generation)
        yield* outbox.enqueue(request)
        yield* sql`
          UPDATE workflow_outbox SET due_at = ${dueAt}
          WHERE workflow_tag = ${request.workflowTag} AND execution_key = ${request.executionKey}
            AND accepted_at IS NULL AND attempts = 0
        `
        yield* sql`
          UPDATE sync_target SET dispatched_generation = ${generation}, updated_at = CLOCK_TIMESTAMP()
          WHERE scope_key = ${syncScopeKey(scope)}
        `
      })

    const invalidate = Effect.fn("SyncTargets.invalidate")(function* (request: InvalidateRequest) {
      const scopeKey = syncScopeKey(request.scope)
      const scopeJson = yield* encodeScope(request.scope).pipe(wrap("invalidate"))
      const sequence = Option.getOrNull(request.sequence)
      const full = request.full === true
      const rows = yield* sql`
        INSERT INTO sync_target (scope_key, scope, requested_generation, requested_sequence, debounce_started_at, full_requested)
        VALUES (${scopeKey}, ${scopeJson}::jsonb, 1, ${sequence}, CLOCK_TIMESTAMP(), ${full})
        ON CONFLICT (scope_key) DO UPDATE SET
          requested_generation = sync_target.requested_generation + 1,
          requested_sequence = GREATEST(COALESCE(sync_target.requested_sequence, 0), COALESCE(EXCLUDED.requested_sequence, 0)),
          debounce_started_at = COALESCE(sync_target.debounce_started_at, CLOCK_TIMESTAMP()),
          full_requested = sync_target.full_requested OR EXCLUDED.full_requested,
          updated_at = CLOCK_TIMESTAMP()
        RETURNING *
      `.pipe(Effect.flatMap(decodeRows), wrap("invalidate"))
      const row = rows[0]
      if (row === undefined) {
        return yield* new SyncTargetError({
          operation: "invalidate",
          message: "No target row returned",
        })
      }
      // A run is pending or active while dispatched exceeds completed; it will
      // either pick up this generation at begin or create the follow-up at completion.
      const runInFlight = gt(row.dispatched_generation, row.completed_generation)
      if (runInFlight) {
        return { generation: row.requested_generation, dispatched: false }
      }
      yield* enqueueRun(request.scope, row.requested_generation).pipe(wrap("invalidate"))
      return { generation: row.requested_generation, dispatched: true }
    })

    const begin = Effect.fn("SyncTargets.begin")(function* (
      scope: SyncScope,
      generation: SyncGeneration,
    ) {
      const scopeKey = syncScopeKey(scope)
      const rows = yield* sql`
        UPDATE sync_target
        SET dispatched_generation = GREATEST(dispatched_generation, requested_generation),
            debounce_started_at = NULL,
            updated_at = CLOCK_TIMESTAMP()
        WHERE scope_key = ${scopeKey} AND completed_generation < ${generation}
        RETURNING *
      `.pipe(Effect.flatMap(decodeRows), wrap("begin"))
      const row = rows[0]
      if (row === undefined) {
        return { _tag: "Superseded" } as const
      }
      return {
        _tag: "Run",
        generation: row.requested_generation,
        sequence: Option.fromNullishOr(row.requested_sequence),
        watermark: Option.fromNullishOr(row.scan_watermark),
        full: row.full_requested,
      } as const
    })

    const complete = Effect.fn("SyncTargets.complete")(function* (request: CompleteRequest) {
      const scopeKey = syncScopeKey(request.scope)
      const { outcome } = request
      const verified = outcome._tag === "Verified"
      const watermark =
        outcome._tag === "Verified"
          ? Option.getOrNull(Option.map(outcome.watermark, DateTime.toDateUtc))
          : null
      const rows = yield* sql`
        UPDATE sync_target
        SET completed_generation = GREATEST(completed_generation, ${request.generation}),
            scan_watermark = COALESCE(${watermark}, scan_watermark),
            full_requested = CASE WHEN ${verified} THEN FALSE ELSE full_requested END,
            verified_generation = CASE WHEN ${verified} THEN GREATEST(verified_generation, ${request.generation}) ELSE verified_generation END,
            verified_sequence = CASE WHEN ${verified} THEN requested_sequence ELSE verified_sequence END,
            verified_at = CASE WHEN ${verified} THEN CLOCK_TIMESTAMP() ELSE verified_at END,
            health = ${outcome._tag === "Blocked" ? "blocked" : "ok"},
            blocked_reason = ${outcome._tag === "Blocked" ? outcome.reason : null},
            last_error = ${outcome._tag === "Failed" ? outcome.error : null},
            updated_at = CLOCK_TIMESTAMP()
        WHERE scope_key = ${scopeKey}
        RETURNING *
      `.pipe(Effect.flatMap(decodeRows), wrap("complete"))
      const row = rows[0]
      if (row === undefined) {
        return yield* new SyncTargetError({
          operation: "complete",
          message: `Unknown scope ${scopeKey}`,
        })
      }
      if (gt(row.requested_generation, request.generation)) {
        yield* enqueueRun(request.scope, row.requested_generation).pipe(wrap("complete"))
        return true
      }
      return false
    })

    const get = Effect.fn("SyncTargets.get")(function* (scope: SyncScope) {
      const rows = yield* sql`
        SELECT * FROM sync_target WHERE scope_key = ${syncScopeKey(scope)}
      `.pipe(Effect.flatMap(decodeRows), wrap("get"))
      return Option.map(Option.fromNullishOr(rows[0]), toRecord)
    })

    return { invalidate, begin, complete, get }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
