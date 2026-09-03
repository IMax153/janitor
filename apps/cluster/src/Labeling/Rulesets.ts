import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import {
  emptyRuleset,
  Ruleset,
  type RulesetAuthor,
  type RulesetIssue,
  RulesetRevision,
  type RulesetView,
  type SynchronizedLabel,
  validateRuleset,
} from "@janitor/domain/Labeling/Ruleset"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubReadModel } from "../GitHub/ReadModel.ts"
import { describeError } from "../SqlErrors.ts"
import { freshnessOf } from "../SyncFreshness.ts"
import { SyncTargets } from "../SyncTargets.ts"

/** Configuration display tolerates older label verification than evaluation will. */
export const RULESET_LABEL_MAX_AGE = Duration.hours(24)

export class LabelingRulesetsError extends Data.TaggedError("LabelingRulesetsError")<{
  readonly operation: string
  readonly message: string
}> {}

export class RepositoryNotFound extends Data.TaggedError("RepositoryNotFound")<{
  readonly repositoryId: GitHubRepositoryDatabaseId
}> {}

/** The caller edited a revision that is no longer the configured one. */
export class RulesetConflict extends Data.TaggedError("RulesetConflict")<{
  readonly current: RulesetView
}> {}

export class RulesetInvalid extends Data.TaggedError("RulesetInvalid")<{
  readonly issues: ReadonlyArray<RulesetIssue>
}> {}

export interface SaveRuleset {
  readonly repositoryId: GitHubRepositoryDatabaseId
  readonly expectedRevision: RulesetRevision
  readonly ruleset: Ruleset
  readonly author: RulesetAuthor
}

const RevisionFromText = Schema.FiniteFromString.pipe(Schema.decodeTo(RulesetRevision))

const CurrentRow = Schema.Struct({
  configured_revision: RevisionFromText,
  active_revision: Schema.NullOr(RevisionFromText),
  ruleset: Ruleset,
})

const LockRow = Schema.Struct({ configured_revision: RevisionFromText })

const ZERO = RulesetRevision.make(0)

/**
 * Loads and saves auto-labeling rulesets. Saves are whole-ruleset,
 * optimistic on the configured revision, and validated against the labels
 * synchronization currently knows for the repository.
 */
export class LabelingRulesets extends Context.Service<
  LabelingRulesets,
  {
    readonly load: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<RulesetView, RepositoryNotFound | LabelingRulesetsError>
    readonly save: (
      request: SaveRuleset,
    ) => Effect.Effect<
      RulesetView,
      RepositoryNotFound | RulesetConflict | RulesetInvalid | LabelingRulesetsError
    >
  }
>()("@janitor/cluster/Labeling/Rulesets/LabelingRulesets", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const readModel = yield* GitHubReadModel
    const targets = yield* SyncTargets
    const decodeCurrent = Schema.decodeUnknownEffect(Schema.Array(CurrentRow))
    const decodeLock = Schema.decodeUnknownEffect(Schema.Array(LockRow))
    const encodeRuleset = Schema.encodeEffect(Schema.fromJsonString(Ruleset))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new LabelingRulesetsError({ operation, message: describeError(error) }),
        )

    const requireRepository = (repositoryId: GitHubRepositoryDatabaseId) =>
      readModel.getRepository(repositoryId).pipe(
        wrap("getRepository"),
        Effect.flatMap((repository) =>
          Option.isSome(repository)
            ? Effect.void
            : Effect.fail(new RepositoryNotFound({ repositoryId })),
        ),
      )

    const synchronizedLabels = (repositoryId: GitHubRepositoryDatabaseId) =>
      Effect.gen(function* () {
        const records = yield* readModel.listLabels(repositoryId)
        const labels: ReadonlyArray<SynchronizedLabel> = records.map((label) => ({
          labelId: label.labelId,
          name: label.name,
          availability: label.availability,
        }))
        const target = yield* targets.get({
          _tag: "RepositoryTrack",
          repositoryId,
          track: "labels",
        })
        const freshness = freshnessOf(target, yield* DateTime.now, RULESET_LABEL_MAX_AGE)
        return { labels, freshness }
      }).pipe(wrap("listLabels"))

    const current = (repositoryId: GitHubRepositoryDatabaseId) =>
      sql`
        SELECT r.configured_revision::text, r.active_revision::text, v.ruleset
        FROM labeling_repository_rules r
        JOIN labeling_ruleset_revision v
          ON v.repository_id = r.repository_id AND v.revision = r.configured_revision
        WHERE r.repository_id = ${repositoryId}
      `.pipe(
        Effect.flatMap(decodeCurrent),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        wrap("current"),
      )

    const view = (repositoryId: GitHubRepositoryDatabaseId) =>
      Effect.gen(function* () {
        const [rules, { labels, freshness }] = yield* Effect.all(
          [current(repositoryId), synchronizedLabels(repositoryId)],
          { concurrency: 2 },
        )
        const result: RulesetView = {
          repositoryId,
          configuredRevision: Option.isSome(rules) ? rules.value.configured_revision : ZERO,
          configured: Option.isSome(rules) ? rules.value.ruleset : emptyRuleset,
          activeRevision: Option.isSome(rules) ? rules.value.active_revision : null,
          labels,
          labelFreshness: freshness,
        }
        return result
      })

    const load = Effect.fn("LabelingRulesets.load")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      yield* requireRepository(repositoryId)
      return yield* view(repositoryId)
    })

    const save = Effect.fn("LabelingRulesets.save")(function* (request: SaveRuleset) {
      const { repositoryId } = request
      yield* requireRepository(repositoryId)
      const encoded = yield* encodeRuleset(request.ruleset).pipe(wrap("encode"))

      const saved = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const locked = yield* sql`
              SELECT configured_revision::text FROM labeling_repository_rules
              WHERE repository_id = ${repositoryId} FOR UPDATE
            `.pipe(Effect.flatMap(decodeLock))
            const configured = locked[0]?.configured_revision ?? ZERO
            if (configured !== request.expectedRevision) {
              return false
            }
            const { labels } = yield* synchronizedLabels(repositoryId)
            const issues = validateRuleset(request.ruleset, labels)
            if (issues.length > 0) {
              return yield* new RulesetInvalid({ issues })
            }
            const next = RulesetRevision.make(configured + 1)
            yield* sql`
              INSERT INTO labeling_ruleset_revision
                (repository_id, revision, ruleset, saved_by_issuer, saved_by_subject)
              VALUES (${repositoryId}, ${next}, ${encoded}::jsonb,
                      ${request.author.issuer}, ${request.author.subject})
            `
            yield* sql`
              INSERT INTO labeling_repository_rules (repository_id, configured_revision)
              VALUES (${repositoryId}, ${next})
              ON CONFLICT (repository_id) DO UPDATE SET
                configured_revision = EXCLUDED.configured_revision,
                updated_at = CLOCK_TIMESTAMP()
            `
            return true
          }),
        )
        .pipe(
          Effect.catchIf(
            (error): error is Exclude<typeof error, RulesetInvalid> =>
              !(error instanceof RulesetInvalid),
            (error) =>
              Effect.fail(
                new LabelingRulesetsError({ operation: "save", message: describeError(error) }),
              ),
          ),
        )

      const result = yield* view(repositoryId)
      if (!saved) {
        return yield* new RulesetConflict({ current: result })
      }
      yield* Effect.logInfo("Saved auto-labeling ruleset").pipe(
        Effect.annotateLogs({
          repositoryId,
          revision: result.configuredRevision,
          rules: request.ruleset.rules.length,
        }),
      )
      return result
    })

    return { load, save }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
