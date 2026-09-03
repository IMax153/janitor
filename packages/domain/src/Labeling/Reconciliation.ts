import * as Schema from "effect/Schema"
import { GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import { GitHubRepositoryAccess } from "../GitHub/ReadModel.ts"
import { SyncGeneration } from "../GitHub/Sync.ts"
import { GitHubWebhookJournalSequence } from "../GitHub/WebhookJournal.ts"
import { Plan } from "./Evaluation.ts"
import { RulesetRevision } from "./Ruleset.ts"

/**
 * A reconciliation identity (design: "Qualified snapshots are evaluation
 * inputs"): entity, synchronized snapshot generation, and the active rules
 * revision. The AI approval revision joins once AI exists.
 */
export const ReconciliationIdentity = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  snapshotGeneration: SyncGeneration,
  rulesRevision: RulesetRevision,
}).annotate({ identifier: "ReconciliationIdentity" })
export type ReconciliationIdentity = typeof ReconciliationIdentity.Type

export const reconciliationKey = (identity: ReconciliationIdentity): string =>
  `reconcile:${identity.repositoryId}:${identity.number}:${identity.snapshotGeneration}:${identity.rulesRevision}`

/**
 * `evaluated` is the terminal success. `superseded` means a newer snapshot
 * or revision replaced this identity before it ran. `not-qualified` means the
 * snapshot was no longer verified when the workflow loaded it.
 */
export const ReconciliationOutcome = Schema.Literals([
  "evaluated",
  "superseded",
  "not-qualified",
  "failed",
]).annotate({ identifier: "ReconciliationOutcome" })
export type ReconciliationOutcome = typeof ReconciliationOutcome.Type

export const ReconciliationRecord = Schema.Struct({
  ...ReconciliationIdentity.fields,
  coveredSequence: GitHubWebhookJournalSequence,
  /** Hash of the fields and labels rules read, so unchanged inputs are recognisable. */
  fingerprint: Schema.String,
  createdAt: Schema.DateTimeUtc,
  outcome: Schema.NullOr(ReconciliationOutcome),
  detail: Schema.NullOr(Schema.String),
  /** Present once the outcome is `evaluated`. Nothing is applied yet. */
  plan: Schema.NullOr(Plan),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
}).annotate({ identifier: "ReconciliationRecord" })
export type ReconciliationRecord = typeof ReconciliationRecord.Type

/** One row of the repositories list in the UI. */
export const RepositoryOverview = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  owner: Schema.String,
  repo: Schema.String,
  enabled: Schema.Boolean,
  access: GitHubRepositoryAccess,
  configuredRevision: Schema.NullOr(RulesetRevision),
  activeRevision: Schema.NullOr(RulesetRevision),
}).annotate({ identifier: "RepositoryOverview" })
export type RepositoryOverview = typeof RepositoryOverview.Type
