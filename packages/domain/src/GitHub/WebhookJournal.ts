import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

const JournalSequenceString = Schema.NonEmptyString.check(
  Schema.isPattern(/^[1-9][0-9]*$/),
).annotate({ identifier: "GitHubWebhookJournalSequenceString" })

const JournalSequenceNumber = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  identifier: "GitHubWebhookJournalSequenceNumber",
})

/**
 * Monotonic receipt sequence assigned by the journal. Postgres returns BIGINT
 * as a decimal string, so the canonical form is a string.
 */
export const GitHubWebhookJournalSequence = JournalSequenceString.pipe(
  Schema.brand("GitHubWebhookJournalSequence"),
).annotate({ identifier: "GitHubWebhookJournalSequence" })
export type GitHubWebhookJournalSequence = typeof GitHubWebhookJournalSequence.Type

export const GitHubWebhookJournalSequenceFromNumber = JournalSequenceNumber.pipe(
  Schema.decodeTo(JournalSequenceString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubWebhookJournalSequence"),
).annotate({ identifier: "GitHubWebhookJournalSequenceFromNumber" })

export const GitHubWebhookJournalSequenceFromStringOrNumber = Schema.Union([
  GitHubWebhookJournalSequenceFromNumber,
  GitHubWebhookJournalSequence,
]).annotate({ identifier: "GitHubWebhookJournalSequenceFromStringOrNumber" })

export const GitHubWebhookProjectionStatus = Schema.Literals([
  "pending",
  "projected",
  "failed",
]).annotate({ identifier: "GitHubWebhookProjectionStatus" })
export type GitHubWebhookProjectionStatus = typeof GitHubWebhookProjectionStatus.Type

/**
 * Written to the dead-letter queue when a queue message cannot be journaled.
 * `body` is the original message body, which only ever holds ciphertext.
 */
export const GitHubWebhookDeadLetterV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  messageId: Schema.NonEmptyString,
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reason: Schema.NonEmptyString,
  body: Schema.Unknown,
}).annotate({ identifier: "GitHubWebhookDeadLetterV1" })
export type GitHubWebhookDeadLetterV1 = typeof GitHubWebhookDeadLetterV1.Type
