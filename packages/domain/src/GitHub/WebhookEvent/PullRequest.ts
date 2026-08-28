import * as Schema from "effect/Schema"
import {
  GitHubInstallationIdFromStringOrNumber,
  GitHubRepositoryDatabaseIdFromStringOrNumber,
  GitHubRepositoryFullNameFromString,
} from "../Repository.ts"
import { BaseGitHubWebhookEvent } from "./Base.ts"

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  identifier: "PositiveInteger",
})
const GitCommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i)).annotate({
  identifier: "GitCommitSha",
})

const PullRequestUser = Schema.Struct({
  login: Schema.NonEmptyString,
}).annotate({ identifier: "PullRequestUser" })

const PullRequestHead = Schema.Struct({
  sha: GitCommitSha,
}).annotate({ identifier: "PullRequestHead" })

const PullRequestBase = Schema.Struct({
  ref: Schema.NonEmptyString,
}).annotate({ identifier: "PullRequestBase" })

export const PullRequest = Schema.Struct({
  id: PositiveInteger,
  number: PositiveInteger,
  nodeId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  body: Schema.Union([Schema.String, Schema.Null]),
  draft: Schema.Boolean,
  user: PullRequestUser,
  head: PullRequestHead,
  base: PullRequestBase,
})
  .pipe(Schema.encodeKeys({ nodeId: "node_id" }))
  .annotate({ identifier: "PullRequest" })
export type PullRequest = typeof PullRequest.Type

export const PullRequestRepository = Schema.Struct({
  id: GitHubRepositoryDatabaseIdFromStringOrNumber,
  fullName: GitHubRepositoryFullNameFromString,
})
  .pipe(Schema.encodeKeys({ fullName: "full_name" }))
  .annotate({ identifier: "PullRequestRepository" })
export type PullRequestRepository = typeof PullRequestRepository.Type

const PullRequestInstallation = Schema.Struct({
  id: GitHubInstallationIdFromStringOrNumber,
}).annotate({ identifier: "PullRequestInstallation" })

const PullRequestSender = Schema.Struct({
  id: PositiveInteger,
  login: Schema.NonEmptyString,
}).annotate({ identifier: "PullRequestSender" })

const PullRequestLabel = Schema.Struct({
  id: PositiveInteger,
  name: Schema.NonEmptyString,
}).annotate({ identifier: "PullRequestLabel" })

const PullRequestStringChange = Schema.Struct({
  from: Schema.String,
}).annotate({ identifier: "PullRequestStringChange" })

const PullRequestNullableStringChange = Schema.Struct({
  from: Schema.Union([Schema.String, Schema.Null]),
}).annotate({ identifier: "PullRequestNullableStringChange" })

const PullRequestBaseChange = Schema.Struct({
  ref: PullRequestStringChange,
  sha: PullRequestStringChange,
}).annotate({ identifier: "PullRequestBaseChange" })

const PullRequestChanges = Schema.Struct({
  title: Schema.optionalKey(PullRequestStringChange),
  body: Schema.optionalKey(PullRequestNullableStringChange),
  base: Schema.optionalKey(PullRequestBaseChange),
}).annotate({ identifier: "PullRequestChanges" })

export const PullRequestWebhookPayloadBase = Schema.Struct({
  pullRequest: PullRequest,
  repository: PullRequestRepository,
  installation: PullRequestInstallation,
  sender: PullRequestSender,
})

const BasePullRequestPayloadStruct = PullRequestWebhookPayloadBase.pipe(
  Schema.fieldsAssign({ number: PositiveInteger }),
)

export const BasePullRequestPayload = BasePullRequestPayloadStruct.pipe(
  Schema.encodeKeys({ pullRequest: "pull_request" }),
).annotate({ identifier: "BasePullRequestPayload" })
export type BasePullRequestPayload = typeof BasePullRequestPayload.Type

export const PullRequestOpened = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({ action: Schema.Literal("opened") }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestOpened" })
export type PullRequestOpened = typeof PullRequestOpened.Type

export const PullRequestReopened = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({ action: Schema.Literal("reopened") }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestReopened" })
export type PullRequestReopened = typeof PullRequestReopened.Type

export const PullRequestSynchronized = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({
    action: Schema.Literal("synchronize"),
    before: GitCommitSha,
    after: GitCommitSha,
  }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestSynchronized" })
export type PullRequestSynchronized = typeof PullRequestSynchronized.Type

export const PullRequestEdited = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({
    action: Schema.Literal("edited"),
    changes: PullRequestChanges,
  }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestEdited" })
export type PullRequestEdited = typeof PullRequestEdited.Type

export const PullRequestReadyForReview = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({ action: Schema.Literal("ready_for_review") }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestReadyForReview" })
export type PullRequestReadyForReview = typeof PullRequestReadyForReview.Type

export const PullRequestConvertedToDraft = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({ action: Schema.Literal("converted_to_draft") }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestConvertedToDraft" })
export type PullRequestConvertedToDraft = typeof PullRequestConvertedToDraft.Type

export const PullRequestLabeled = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({
    action: Schema.Literal("labeled"),
    label: PullRequestLabel,
  }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestLabeled" })
export type PullRequestLabeled = typeof PullRequestLabeled.Type

export const PullRequestUnlabeled = BasePullRequestPayloadStruct.pipe(
  Schema.fieldsAssign({
    action: Schema.Literal("unlabeled"),
    label: PullRequestLabel,
  }),
)
  .pipe(Schema.encodeKeys({ pullRequest: "pull_request" }))
  .annotate({ identifier: "PullRequestUnlabeled" })
export type PullRequestUnlabeled = typeof PullRequestUnlabeled.Type

export const PullRequestWebhookPayload = Schema.Union([
  PullRequestOpened,
  PullRequestReopened,
  PullRequestSynchronized,
  PullRequestEdited,
  PullRequestReadyForReview,
  PullRequestConvertedToDraft,
  PullRequestLabeled,
  PullRequestUnlabeled,
])
  .annotate({
    identifier: "PullRequestWebhookPayload",
    message: "Unsupported or malformed pull request webhook action",
  })
  .pipe(Schema.toTaggedUnion("action"))
export type PullRequestWebhookPayload = typeof PullRequestWebhookPayload.Type

export const PullRequestWebhookEvent = BaseGitHubWebhookEvent.pipe(
  Schema.fieldsAssign({
    name: Schema.Literal("pull_request"),
    payload: PullRequestWebhookPayload,
  }),
).annotate({ identifier: "PullRequestWebhookEvent" })
export type PullRequestWebhookEvent = typeof PullRequestWebhookEvent.Type
