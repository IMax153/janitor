import type { SyncScope, SyncSummary } from "@janitor/domain/GitHub/Sync"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { describeError } from "./SqlErrors.ts"
import { SYNC_IN_FLIGHT_TIMEOUT, SyncTargets } from "./SyncTargets.ts"

export class SyncStatusError extends Data.TaggedError("SyncStatusError")<{
  readonly operation: string
  readonly message: string
}> {}

const SummaryRow = Schema.Struct({
  pending: Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int)),
  blocked: Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int)),
  last_verified_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
})

const InstallationRow = Schema.Struct({ installation_id: GitHubInstallationId })
const RepositoryRow = Schema.Struct({ repository_id: GitHubRepositoryDatabaseId })

export interface RequestAllResult {
  readonly summary: SyncSummary
  /** Scopes that received a new generation. */
  readonly requested: number
}

/**
 * The whole-system sync view behind the re-sync button: one summary and one
 * "sync everything" request. Requests go through sync targets, so debounce,
 * in-flight suppression, and follow-ups apply exactly as they do for
 * webhooks and repair.
 */
export class SyncStatus extends Context.Service<
  SyncStatus,
  {
    readonly summary: Effect.Effect<SyncSummary, SyncStatusError>
    readonly requestAll: Effect.Effect<RequestAllResult, SyncStatusError>
  }
>()("@janitor/cluster/SyncStatus/SyncStatus", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const targets = yield* SyncTargets
    const decodeSummary = Schema.decodeUnknownEffect(Schema.Array(SummaryRow))
    const decodeInstallations = Schema.decodeUnknownEffect(Schema.Array(InstallationRow))
    const decodeRepositories = Schema.decodeUnknownEffect(Schema.Array(RepositoryRow))
    const inFlightInterval = `${Duration.toSeconds(SYNC_IN_FLIGHT_TIMEOUT)} seconds`

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new SyncStatusError({ operation, message: describeError(error) }),
        )

    const summary = Effect.gen(function* () {
      const rows = yield* sql`
        SELECT
          COUNT(*) FILTER (
            WHERE requested_generation > completed_generation
              AND updated_at > CLOCK_TIMESTAMP() - ${inFlightInterval}::interval
          )::text AS pending,
          COUNT(*) FILTER (WHERE health = 'blocked')::text AS blocked,
          MAX(verified_at) AS last_verified_at
        FROM sync_target
      `.pipe(Effect.flatMap(decodeSummary), wrap("summary"))
      const row = rows[0]
      const pending = row?.pending ?? 0
      const blocked = row?.blocked ?? 0
      const result: SyncSummary = {
        state: pending > 0 ? "syncing" : blocked > 0 ? "blocked" : "idle",
        lastVerifiedAt: row?.last_verified_at ?? null,
        pendingTargets: pending,
        blockedTargets: blocked,
      }
      return result
    }).pipe(Effect.withSpan("SyncStatus.summary"))

    const requestAll = Effect.gen(function* () {
      const requested = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const installations = yield* sql`
              SELECT installation_id FROM github_installation WHERE status = 'active'
            `.pipe(Effect.flatMap(decodeInstallations))
            const repositories = yield* sql`
              SELECT repository_id FROM github_repository
              WHERE enabled AND access = 'accessible'
            `.pipe(Effect.flatMap(decodeRepositories))

            const scopes: Array<SyncScope> = installations.map((row) => ({
              _tag: "InstallationInventory",
              installationId: row.installation_id,
            }))
            for (const row of repositories) {
              for (const track of ["labels", "entities", "pull_requests"] as const) {
                scopes.push({ _tag: "RepositoryTrack", repositoryId: row.repository_id, track })
              }
            }
            for (const scope of scopes) {
              yield* targets.invalidate({ scope, sequence: Option.none() })
            }
            return scopes.length
          }),
        )
        .pipe(wrap("requestAll"))
      yield* Effect.logInfo("Requested a sync of every scope").pipe(
        Effect.annotateLogs({ requested }),
      )
      return { summary: yield* summary, requested }
    }).pipe(Effect.withSpan("SyncStatus.requestAll"))

    return { summary, requestAll }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
