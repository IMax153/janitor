import * as Schema from "effect/Schema"
import * as Struct from "effect/Struct"
import { BaseGitHubWebhookEvent } from "./Base.ts"
import { PullRequestWebhookPayloadBase } from "./PullRequest.ts"

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  identifier: "PositiveInteger",
})
const GitCommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i)).annotate({
  identifier: "GitCommitSha",
})

export const CommitStatusState = Schema.Literals([
  "error",
  "failure",
  "pending",
  "success",
]).annotate({ identifier: "CommitStatusState" })
export type CommitStatusState = typeof CommitStatusState.Type

const CommitStatusWebhookPayloadBase = PullRequestWebhookPayloadBase.mapFields(
  Struct.pick(["repository", "installation", "sender"]),
).mapFields(Struct.evolve({ installation: (schema) => Schema.optionalKey(schema) }))

export const CommitStatusWebhookPayload = CommitStatusWebhookPayloadBase.pipe(
  Schema.fieldsAssign({
    id: PositiveInteger,
    sha: GitCommitSha,
    name: Schema.String,
    targetUrl: Schema.NullOr(Schema.String),
    context: Schema.String,
    description: Schema.Union([Schema.String, Schema.Null]),
    state: CommitStatusState,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
  Schema.encodeKeys({
    targetUrl: "target_url",
    createdAt: "created_at",
    updatedAt: "updated_at",
  }),
).annotate({ identifier: "CommitStatusWebhookPayload" })
export type CommitStatusWebhookPayload = typeof CommitStatusWebhookPayload.Type

export const CommitStatusWebhookEvent = BaseGitHubWebhookEvent.pipe(
  Schema.fieldsAssign({
    name: Schema.Literal("status"),
    payload: CommitStatusWebhookPayload,
  }),
).annotate({ identifier: "CommitStatusWebhookEvent" })
export type CommitStatusWebhookEvent = typeof CommitStatusWebhookEvent.Type
