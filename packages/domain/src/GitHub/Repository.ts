import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Model from "effect/unstable/schema/Model"
import { lifecycleTimestamps } from "../Shared/Timestamps.ts"

const GitHubRepositoryNameSegment = Schema.NonEmptyString.check(
  Schema.isPattern(/^[^/\s]+$/),
).annotate({ identifier: "GitHubRepositoryNameSegment" })

export const GitHubRepositoryFullName = Schema.Struct({
  owner: GitHubRepositoryNameSegment,
  repo: GitHubRepositoryNameSegment,
}).annotate({ identifier: "GitHubRepositoryFullName" })
export type GitHubRepositoryFullName = typeof GitHubRepositoryFullName.Type

export const GitHubRepositoryFullNameFromString = Schema.TemplateLiteralParser([
  GitHubRepositoryNameSegment,
  Schema.Literal("/"),
  GitHubRepositoryNameSegment,
])
  .pipe(
    Schema.decodeTo(GitHubRepositoryFullName, {
      decode: SchemaGetter.transform(([owner, _, repo]) => ({ owner, repo })),
      encode: SchemaGetter.transform(({ owner, repo }) => [owner, "/", repo]),
    }),
  )
  .annotate({ identifier: "GitHubRepositoryFullNameFromString" })

const GitHubIdString = Schema.NonEmptyString.check(Schema.isPattern(/^[1-9][0-9]*$/)).annotate({
  identifier: "GitHubIdString",
})
const GitHubIdNumber = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  identifier: "GitHubIdNumber",
})

export const GitHubRepositoryDatabaseId = GitHubIdString.pipe(
  Schema.brand("GitHubRepositoryDatabaseId"),
).annotate({ identifier: "GitHubRepositoryDatabaseId" })
export type GitHubRepositoryDatabaseId = typeof GitHubRepositoryDatabaseId.Type

export const GitHubRepositoryDatabaseIdFromNumber = GitHubIdNumber.pipe(
  Schema.decodeTo(GitHubIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubRepositoryDatabaseId"),
).annotate({ identifier: "GitHubRepositoryDatabaseIdFromNumber" })

export const GitHubRepositoryDatabaseIdFromStringOrNumber = Schema.Union([
  GitHubRepositoryDatabaseIdFromNumber,
  GitHubRepositoryDatabaseId,
]).annotate({ identifier: "GitHubRepositoryDatabaseIdFromStringOrNumber" })

export const GitHubInstallationId = GitHubIdString.pipe(
  Schema.brand("GitHubInstallationId"),
).annotate({
  identifier: "GitHubInstallationId",
})
export type GitHubInstallationId = typeof GitHubInstallationId.Type

export const GitHubInstallationIdFromNumber = GitHubIdNumber.pipe(
  Schema.decodeTo(GitHubIdString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubInstallationId"),
).annotate({ identifier: "GitHubInstallationIdFromNumber" })

export const GitHubInstallationIdFromStringOrNumber = Schema.Union([
  GitHubInstallationIdFromNumber,
  GitHubInstallationId,
]).annotate({ identifier: "GitHubInstallationIdFromStringOrNumber" })

export const GitHubRepositoryId = Schema.NonEmptyString.check(Schema.isUUID(7))
  .pipe(Schema.brand("GitHubRepositoryId"))
  .annotate({
    identifier: "GitHubRepositoryId",
  })
export type GitHubRepositoryId = typeof GitHubRepositoryId.Type

export class GitHubRepository extends Model.Class<GitHubRepository>("GitHubRepository")({
  id: Model.UuidV7Insert(GitHubRepositoryId),
  githubDatabaseId: GitHubRepositoryDatabaseId,
  owner: GitHubRepositoryFullName.fields.owner,
  repo: GitHubRepositoryFullName.fields.repo,
  isPrivate: Schema.Boolean,
  installationId: GitHubInstallationId,
  enabled: Schema.Boolean,
  rulesRevision: Schema.Int,
  ...lifecycleTimestamps,
}) {
  get fullName(): string {
    return this.owner + "/" + this.repo
  }
}
