import type { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import type {
  GitHubWebhookEncryptionV1,
  GitHubWebhookName,
  GitHubWebhookPayloadSha256,
} from "@janitor/domain/GitHub/WebhookEnvelope"
import {
  GitHubWebhookJournalSequence,
  GitHubWebhookJournalSequenceFromStringOrNumber,
} from "@janitor/domain/GitHub/WebhookJournal"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export class GitHubWebhookJournalError extends Schema.TaggedError<GitHubWebhookJournalError>()(
  "@janitor/cluster/GitHub/WebhookJournal/GitHubWebhookJournalError",
  {
    deliveryId: Schema.String,
    message: Schema.String,
  },
) {}

export interface GitHubWebhookJournalEntry {
  readonly deliveryId: GitHubWebhookDeliveryId
  readonly eventName: GitHubWebhookName
  readonly receivedAt: DateTime.Utc
  readonly payloadSha256: GitHubWebhookPayloadSha256
  readonly encryption: GitHubWebhookEncryptionV1
  /** Ciphertext. The journal never holds plaintext. */
  readonly payload: Uint8Array
}

export interface GitHubWebhookJournalReceipt {
  readonly sequence: GitHubWebhookJournalSequence
  /** True when the delivery ID was already journaled by an earlier attempt. */
  readonly duplicate: boolean
}

/**
 * Durable record of every accepted webhook delivery. Delivery ID uniqueness
 * makes recording idempotent, so a lost acknowledgement retries safely.
 */
export class GitHubWebhookJournal extends Context.Service<
  GitHubWebhookJournal,
  {
    readonly record: (
      entry: GitHubWebhookJournalEntry,
    ) => Effect.Effect<GitHubWebhookJournalReceipt, GitHubWebhookJournalError>
  }
>()("@janitor/cluster/GitHub/WebhookJournal/GitHubWebhookJournal", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const SequenceRow = Schema.Struct({ sequence: GitHubWebhookJournalSequenceFromStringOrNumber })
    const decodeRows = Schema.decodeUnknownEffect(Schema.Array(SequenceRow))

    const record = Effect.fn("GitHubWebhookJournal.record")(function* (
      entry: GitHubWebhookJournalEntry,
    ) {
      const row = {
        delivery_id: entry.deliveryId,
        event_name: entry.eventName,
        received_at: DateTime.toDateUtc(entry.receivedAt),
        payload_sha256: entry.payloadSha256,
        encryption_algorithm: entry.encryption.algorithm,
        encryption_key_id: entry.encryption.keyId,
        encryption_iv: entry.encryption.iv,
        payload: entry.payload,
      }

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const inserted = yield* sql`
              INSERT INTO github_webhook_delivery ${sql.insert(row)}
              ON CONFLICT (delivery_id) DO NOTHING
              RETURNING sequence
            `.pipe(Effect.flatMap(decodeRows))

            const first = inserted[0]
            if (first !== undefined) {
              return { sequence: first.sequence, duplicate: false }
            }

            const existing = yield* sql`
              SELECT sequence FROM github_webhook_delivery
              WHERE delivery_id = ${entry.deliveryId}
            `.pipe(Effect.flatMap(decodeRows))

            const found = existing[0]
            if (found === undefined) {
              return yield* new GitHubWebhookJournalError({
                deliveryId: entry.deliveryId,
                message: "Delivery conflicted on insert but could not be read back",
              })
            }
            return { sequence: found.sequence, duplicate: true }
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: (error) =>
              new GitHubWebhookJournalError({
                deliveryId: entry.deliveryId,
                message: error.message,
              }),
            SchemaError: (error) =>
              new GitHubWebhookJournalError({
                deliveryId: entry.deliveryId,
                message: `Journal returned an invalid sequence: ${error.message}`,
              }),
          }),
        )
    })

    return { record }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
