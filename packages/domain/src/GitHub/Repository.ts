import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as Model from "effect/unstable/schema/Model"
import { lifecycleTimestamps } from "../Shared/Timestamps.ts"
import { GitHubInstallationId, GitHubRepositoryDatabaseId, GitHubRepositoryNodeId } from "./Id.ts"

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

export const GitHubRepositoryId = Schema.NonEmptyString.check(Schema.isUUID(7))
  .pipe(Schema.brand("GitHubRepositoryId"))
  .annotate({
    identifier: "GitHubRepositoryId",
  })
export type GitHubRepositoryId = typeof GitHubRepositoryId.Type

export class GitHubRepository extends Model.Class<GitHubRepository>("GitHubRepository")({
  id: Model.UuidV7Insert(GitHubRepositoryId),
  githubDatabaseId: GitHubRepositoryDatabaseId,
  githubNodeId: GitHubRepositoryNodeId,
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
