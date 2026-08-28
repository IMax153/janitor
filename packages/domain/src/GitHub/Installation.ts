import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Model from "effect/unstable/schema/Model"
import { lifecycleTimestamps } from "../Shared/Timestamps.ts"
import {
  GitHubInstallationId,
  GitHubInstallationIdFromStringOrNumber,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryDatabaseIdFromStringOrNumber,
  GitHubRepositoryFullName,
  GitHubRepositoryFullNameFromString,
} from "./Repository.ts"

const GitHubAccountIdString = Schema.NonEmptyString.check(
  Schema.isPattern(/^[1-9][0-9]*$/),
).annotate({
  identifier: "GitHubAccountIdString",
})
const GitHubAccountIdNumber = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  identifier: "GitHubAccountIdNumber",
})
const GitHubRepositoryCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  identifier: "GitHubRepositoryCount",
})

export const GitHubAccountDatabaseId = GitHubAccountIdString.pipe(
  Schema.brand("GitHubAccountDatabaseId"),
).annotate({ identifier: "GitHubAccountDatabaseId" })
export type GitHubAccountDatabaseId = typeof GitHubAccountDatabaseId.Type

export const GitHubAccountDatabaseIdFromNumber = GitHubAccountIdNumber.pipe(
  Schema.decodeTo(GitHubAccountIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubAccountDatabaseId"),
).annotate({ identifier: "GitHubAccountDatabaseIdFromNumber" })

export const GitHubAccountDatabaseIdFromStringOrNumber = Schema.Union([
  GitHubAccountDatabaseIdFromNumber,
  GitHubAccountDatabaseId,
]).annotate({ identifier: "GitHubAccountDatabaseIdFromStringOrNumber" })

export const GitHubAccountType = Schema.Literals(["Enterprise", "Organization", "User"]).annotate({
  identifier: "GitHubAccountType",
})
export type GitHubAccountType = typeof GitHubAccountType.Type

export const GitHubInstallationRepositorySelection = Schema.Literals(["all", "selected"]).annotate({
  identifier: "GitHubInstallationRepositorySelection",
})
export type GitHubInstallationRepositorySelection =
  typeof GitHubInstallationRepositorySelection.Type

export const GitHubInstallationStatus = Schema.Literals(["active", "suspended"]).annotate({
  identifier: "GitHubInstallationStatus",
})
export type GitHubInstallationStatus = typeof GitHubInstallationStatus.Type

export const GitHubInstallationSyncStatus = Schema.Literals([
  "pending",
  "ready",
  "failed",
]).annotate({
  identifier: "GitHubInstallationSyncStatus",
})
export type GitHubInstallationSyncStatus = typeof GitHubInstallationSyncStatus.Type

export class GitHubInstallation extends Model.Class<GitHubInstallation>("GitHubInstallation")({
  githubDatabaseId: Model.GeneratedByApp(GitHubInstallationId),
  accountDatabaseId: GitHubAccountDatabaseId,
  accountHandle: Schema.NonEmptyString,
  accountType: GitHubAccountType,
  repositorySelection: GitHubInstallationRepositorySelection,
  status: GitHubInstallationStatus,
  syncStatus: GitHubInstallationSyncStatus,
  htmlUrl: Schema.NonEmptyString,
  lastError: Schema.OptionFromNullOr(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
  ...lifecycleTimestamps,
}) {}

const GitHubInstallationUserOrOrganizationAccount = Schema.Struct({
  id: GitHubAccountDatabaseIdFromStringOrNumber,
  login: Schema.NonEmptyString,
  type: Schema.Literals(["Organization", "User"]),
}).annotate({ identifier: "GitHubInstallationUserOrOrganizationAccount" })

const GitHubInstallationEnterpriseAccountApi = Schema.Struct({
  id: GitHubAccountDatabaseIdFromStringOrNumber,
  slug: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
}).annotate({ identifier: "GitHubInstallationEnterpriseAccountApi" })

const GitHubInstallationEnterpriseAccount = GitHubInstallationEnterpriseAccountApi.pipe(
  Schema.extendTo(
    { type: Schema.Literal("Enterprise") },
    { type: () => Option.some<"Enterprise">("Enterprise") },
  ),
).annotate({ identifier: "GitHubInstallationEnterpriseAccount" })

const GitHubInstallationAccount = Schema.Union([
  GitHubInstallationUserOrOrganizationAccount,
  GitHubInstallationEnterpriseAccount,
]).annotate({ identifier: "GitHubInstallationAccount" })

export const GitHubInstallationSuspendingUser = Schema.Struct({
  id: GitHubAccountDatabaseIdFromStringOrNumber,
  login: Schema.NonEmptyString,
}).annotate({ identifier: "GitHubInstallationSuspendingUser" })
export type GitHubInstallationSuspendingUser = typeof GitHubInstallationSuspendingUser.Type

export const GitHubInstallationSummary = Schema.Struct({
  id: GitHubInstallationIdFromStringOrNumber,
  account: GitHubInstallationAccount,
  repositorySelection: GitHubInstallationRepositorySelection,
  htmlUrl: Schema.NonEmptyString,
  suspendedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  suspendedBy: Schema.optionalKey(Schema.NullOr(GitHubInstallationSuspendingUser)),
})
  .pipe(
    Schema.encodeKeys({
      repositorySelection: "repository_selection",
      htmlUrl: "html_url",
      suspendedAt: "suspended_at",
      suspendedBy: "suspended_by",
    }),
  )
  .annotate({ identifier: "GitHubInstallationSummary" })
export type GitHubInstallationSummary = typeof GitHubInstallationSummary.Type

export const GitHubDiscoveredRepository = Schema.Struct({
  githubDatabaseId: GitHubRepositoryDatabaseId,
  owner: GitHubRepositoryFullName.fields.owner,
  repo: GitHubRepositoryFullName.fields.repo,
  isPrivate: Schema.Boolean,
}).annotate({ identifier: "GitHubDiscoveredRepository" })
export type GitHubDiscoveredRepository = typeof GitHubDiscoveredRepository.Type

export const GitHubInstallationRepository = Schema.Struct({
  id: GitHubRepositoryDatabaseIdFromStringOrNumber,
  fullName: GitHubRepositoryFullNameFromString,
  isPrivate: Schema.Boolean,
})
  .pipe(Schema.encodeKeys({ fullName: "full_name", isPrivate: "private" }))
  .annotate({ identifier: "GitHubInstallationRepository" })
export type GitHubInstallationRepository = typeof GitHubInstallationRepository.Type

export const GitHubInstallationRepositoriesResponse = Schema.Struct({
  totalCount: GitHubRepositoryCount,
  repositorySelection: Schema.optionalKey(GitHubInstallationRepositorySelection),
  repositories: Schema.Array(GitHubInstallationRepository),
})
  .pipe(
    Schema.encodeKeys({
      totalCount: "total_count",
      repositorySelection: "repository_selection",
    }),
  )
  .annotate({ identifier: "GitHubInstallationRepositoriesResponse" })
export type GitHubInstallationRepositoriesResponse =
  typeof GitHubInstallationRepositoriesResponse.Type
