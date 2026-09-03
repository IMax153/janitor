import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RulesetPreparation, RulesetRevision } from "@janitor/domain/Labeling/Ruleset"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"

export class RulesetActivationError extends Data.TaggedError("RulesetActivationError")<{
  readonly operation: string
  readonly message: string
}> {}

const RevisionFromText = Schema.FiniteFromString.pipe(Schema.decodeTo(RulesetRevision))

const PendingRow = Schema.Struct({
  repository_id: GitHubRepositoryDatabaseId,
  configured_revision: RevisionFromText,
  required_tracks: RulesetPreparation,
})

const PromotedRow = Schema.Struct({ repository_id: GitHubRepositoryDatabaseId })

/**
 * Promotes a configured ruleset revision to active once every track it
 * recorded at save time has verified at least the generation it requested.
 * Called after a save, after a repository track verifies, and by the repair
 * cron for recovery, so a lost wakeup only delays promotion.
 */
export class RulesetActivation extends Context.Service<
  RulesetActivation,
  {
    /** Returns the revision that became active, if promotion happened now. */
    readonly promote: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<Option.Option<RulesetRevision>, RulesetActivationError>
    /** Promotes every repository whose configured revision is ready. Returns how many. */
    readonly promoteAll: Effect.Effect<number, RulesetActivationError>
  }
>()("@janitor/cluster/Labeling/Activation/RulesetActivation", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const decodePending = Schema.decodeUnknownEffect(Schema.Array(PendingRow))
    const decodePromoted = Schema.decodeUnknownEffect(Schema.Array(PromotedRow))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new RulesetActivationError({ operation, message: describeError(error) }),
        )

    // One statement decides readiness on the database's view of the tracks,
    // so concurrent callers cannot promote on stale reads. A track with no
    // target row or a lower verified generation blocks promotion.
    const promoteReady = (repositoryId: Option.Option<GitHubRepositoryDatabaseId>) =>
      sql`
        WITH candidate AS (
          SELECT r.repository_id, r.configured_revision, v.required_tracks
          FROM labeling_repository_rules r
          JOIN labeling_ruleset_revision v
            ON v.repository_id = r.repository_id AND v.revision = r.configured_revision
          WHERE r.active_revision IS DISTINCT FROM r.configured_revision
            AND (${Option.getOrNull(repositoryId)}::text IS NULL
                 OR r.repository_id = ${Option.getOrNull(repositoryId)})
        ),
        ready AS (
          SELECT c.repository_id, c.configured_revision
          FROM candidate c
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_each_text(c.required_tracks) AS need(track, generation)
            LEFT JOIN sync_target t
              ON t.scope_key = 'repository:' || c.repository_id || ':' || need.track
            WHERE t.scope_key IS NULL
               OR t.health <> 'ok'
               OR t.verified_generation < need.generation::bigint
          )
        )
        UPDATE labeling_repository_rules r
        SET active_revision = ready.configured_revision,
            activated_at = CLOCK_TIMESTAMP(),
            updated_at = CLOCK_TIMESTAMP()
        FROM ready
        WHERE r.repository_id = ready.repository_id
        RETURNING r.repository_id
      `.pipe(Effect.flatMap(decodePromoted))

    const promote = Effect.fn("RulesetActivation.promote")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      const promoted = yield* promoteReady(Option.some(repositoryId)).pipe(wrap("promote"))
      if (promoted.length === 0) {
        return Option.none()
      }
      const rows = yield* sql`
        SELECT repository_id, active_revision::text AS configured_revision, '{}'::jsonb AS required_tracks
        FROM labeling_repository_rules WHERE repository_id = ${repositoryId}
      `.pipe(Effect.flatMap(decodePending), wrap("promote"))
      const revision = rows[0]?.configured_revision
      if (revision === undefined) {
        return Option.none()
      }
      yield* Effect.logInfo("Activated auto-labeling ruleset revision").pipe(
        Effect.annotateLogs({ repositoryId, revision }),
      )
      return Option.some(revision)
    })

    const promoteAll = promoteReady(Option.none()).pipe(
      wrap("promoteAll"),
      Effect.tap((promoted) =>
        promoted.length === 0
          ? Effect.void
          : Effect.logInfo("Activated auto-labeling ruleset revisions").pipe(
              Effect.annotateLogs({
                repositories: promoted.map((row) => row.repository_id).join(","),
              }),
            ),
      ),
      Effect.map((promoted) => promoted.length),
      Effect.withSpan("RulesetActivation.promoteAll"),
    )

    return { promote, promoteAll }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
