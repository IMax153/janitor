import type { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type {
  GitHubInstallationRepository,
  GitHubInstallationSummary,
} from "@janitor/domain/GitHub/Installation"
import {
  GitHubEntityLabelRecord,
  GitHubEntityRecord,
  GitHubInstallationRecord,
  GitHubLabelRecord,
  GitHubPullRequestRecord,
  GitHubRepositoryRecord,
} from "@janitor/domain/GitHub/ReadModel"
import type { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import type {
  GitHubIssueApi,
  GitHubLabelApi,
  GitHubPullRequestApi,
} from "@janitor/domain/GitHub/Api"
import type {
  PullRequestRepository,
  PullRequest,
} from "@janitor/domain/GitHub/WebhookEvent/PullRequest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { describeError } from "../SqlErrors.ts"

export class GitHubReadModelError extends Schema.TaggedError<GitHubReadModelError>()(
  "@janitor/cluster/GitHub/ReadModel/GitHubReadModelError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface InstallationObservation {
  readonly installation: GitHubInstallationSummary
  readonly status: "active" | "suspended" | "deleted"
  readonly sequence: GitHubWebhookJournalSequence
}

export interface RepositoriesObservation {
  readonly installationId: GitHubInstallationId
  readonly repositories: ReadonlyArray<GitHubInstallationRepository>
  readonly sequence: GitHubWebhookJournalSequence
}

export interface RepositoriesPresence {
  readonly installationId: GitHubInstallationId
  /** Repository IDs a complete inventory scan listed. */
  readonly present: ReadonlyArray<GitHubRepositoryDatabaseId>
  readonly sequence: GitHubWebhookJournalSequence
}

export interface PullRequestObservation {
  readonly installationId: GitHubInstallationId
  readonly repository: PullRequestRepository
  readonly pullRequest: PullRequest
  readonly sequence: GitHubWebhookJournalSequence
}

export interface LabelCatalogObservation {
  readonly repositoryId: GitHubRepositoryDatabaseId
  readonly labels: ReadonlyArray<GitHubLabelApi>
  readonly sequence: GitHubWebhookJournalSequence
}

export interface IssueObservation {
  readonly repositoryId: GitHubRepositoryDatabaseId
  readonly issue: GitHubIssueApi
  readonly sequence: GitHubWebhookJournalSequence
}

export interface PullRequestDetailsObservation {
  readonly repositoryId: GitHubRepositoryDatabaseId
  readonly pullRequest: GitHubPullRequestApi
  readonly sequence: GitHubWebhookJournalSequence
}

export type PullRequestProjection =
  | { readonly _tag: "Applied" }
  /** GitHub's update clock or the journal sequence was older than what is stored. */
  | { readonly _tag: "Stale" }

export type PullRequestDetailsProjection =
  | { readonly _tag: "Applied" }
  /** No entity row exists yet; the entity scan has not seen this number. */
  | { readonly _tag: "Unknown" }

const rowsToRecords = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))

const InstallationRow = Schema.Struct({
  installation_id: GitHubInstallationRecord.fields.installationId,
  account_database_id: GitHubInstallationRecord.fields.accountDatabaseId,
  account_handle: GitHubInstallationRecord.fields.accountHandle,
  account_type: GitHubInstallationRecord.fields.accountType,
  repository_selection: GitHubInstallationRecord.fields.repositorySelection,
  status: GitHubInstallationRecord.fields.status,
  html_url: GitHubInstallationRecord.fields.htmlUrl,
  projected_sequence: Schema.String,
  observed_at: Schema.DateTimeUtcFromDate,
})

const RepositoryRow = Schema.Struct({
  repository_id: GitHubRepositoryRecord.fields.repositoryId,
  node_id: GitHubRepositoryRecord.fields.nodeId,
  installation_id: GitHubRepositoryRecord.fields.installationId,
  owner: GitHubRepositoryRecord.fields.owner,
  repo: GitHubRepositoryRecord.fields.repo,
  is_private: GitHubRepositoryRecord.fields.isPrivate,
  access: GitHubRepositoryRecord.fields.access,
  enabled: GitHubRepositoryRecord.fields.enabled,
  projected_sequence: Schema.String,
  observed_at: Schema.DateTimeUtcFromDate,
})

const EntityRow = Schema.Struct({
  repository_id: GitHubEntityRecord.fields.repositoryId,
  number: GitHubEntityRecord.fields.number,
  kind: GitHubEntityRecord.fields.kind,
  issue_id: GitHubEntityRecord.fields.issueId,
  issue_node_id: GitHubEntityRecord.fields.issueNodeId,
  title: GitHubEntityRecord.fields.title,
  body: GitHubEntityRecord.fields.body,
  author_login: GitHubEntityRecord.fields.authorLogin,
  author_id: GitHubEntityRecord.fields.authorId,
  state: GitHubEntityRecord.fields.state,
  github_updated_at: Schema.DateTimeUtcFromDate,
  projected_sequence: Schema.String,
  observed_at: Schema.DateTimeUtcFromDate,
})

const PullRequestRow = Schema.Struct({
  repository_id: GitHubPullRequestRecord.fields.repositoryId,
  number: GitHubPullRequestRecord.fields.number,
  pull_request_id: GitHubPullRequestRecord.fields.pullRequestId,
  pull_request_node_id: GitHubPullRequestRecord.fields.pullRequestNodeId,
  base_ref: GitHubPullRequestRecord.fields.baseRef,
  draft: GitHubPullRequestRecord.fields.draft,
  head_sha: GitHubPullRequestRecord.fields.headSha,
  merged: GitHubPullRequestRecord.fields.merged,
})

const LabelRow = Schema.Struct({
  repository_id: GitHubLabelRecord.fields.repositoryId,
  label_id: GitHubLabelRecord.fields.labelId,
  node_id: GitHubLabelRecord.fields.nodeId,
  name: GitHubLabelRecord.fields.name,
  availability: GitHubLabelRecord.fields.availability,
  projected_sequence: Schema.String,
  observed_at: Schema.DateTimeUtcFromDate,
})

const EntityLabelRow = Schema.Struct({
  repository_id: GitHubEntityLabelRecord.fields.repositoryId,
  number: GitHubEntityLabelRecord.fields.number,
  label_id: GitHubEntityLabelRecord.fields.labelId,
})

const sequenceOf = (raw: string) => GitHubInstallationRecord.fields.projectedSequence.make(raw)

/**
 * Writes webhook observations into the local mirror with per-row fences.
 * Every method joins the caller's transaction when one is open.
 */
export class GitHubReadModel extends Context.Service<
  GitHubReadModel,
  {
    /** Runs `effect` in one database transaction so mirror and status writes commit together. */
    readonly withTransaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GitHubReadModelError, R>
    readonly applyInstallation: (
      observation: InstallationObservation,
    ) => Effect.Effect<void, GitHubReadModelError>
    readonly applyRepositories: (
      observation: RepositoriesObservation,
    ) => Effect.Effect<void, GitHubReadModelError>
    /** Explicit removal from the installation: access is `lost`, identity is kept. */
    readonly markRepositoriesLost: (
      observation: RepositoriesObservation,
    ) => Effect.Effect<void, GitHubReadModelError>
    /** After a complete scan, accessible repositories it did not list become suspect. */
    readonly markRepositoriesSuspect: (
      presence: RepositoriesPresence,
    ) => Effect.Effect<void, GitHubReadModelError>
    readonly applyPullRequest: (
      observation: PullRequestObservation,
    ) => Effect.Effect<PullRequestProjection, GitHubReadModelError>
    /** A complete label scan: upserts every label and marks unlisted ones suspect. */
    readonly applyLabelCatalog: (
      observation: LabelCatalogObservation,
    ) => Effect.Effect<void, GitHubReadModelError>
    /** One item from the issues listing or the single-issue endpoint. */
    readonly applyIssue: (
      observation: IssueObservation,
    ) => Effect.Effect<PullRequestProjection, GitHubReadModelError>
    /** Pull request details; skipped until the entity row exists. */
    readonly applyPullRequestDetails: (
      observation: PullRequestDetailsObservation,
    ) => Effect.Effect<PullRequestDetailsProjection, GitHubReadModelError>
    readonly getInstallation: (
      installationId: GitHubInstallationId,
    ) => Effect.Effect<Option.Option<GitHubInstallationRecord>, GitHubReadModelError>
    readonly getRepository: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<Option.Option<GitHubRepositoryRecord>, GitHubReadModelError>
    readonly getEntity: (
      repositoryId: GitHubRepositoryDatabaseId,
      number: number,
    ) => Effect.Effect<
      Option.Option<{
        readonly entity: GitHubEntityRecord
        readonly pullRequest: Option.Option<GitHubPullRequestRecord>
        readonly labels: ReadonlyArray<GitHubEntityLabelRecord>
      }>,
      GitHubReadModelError
    >
    readonly listLabels: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<ReadonlyArray<GitHubLabelRecord>, GitHubReadModelError>
  }
>()("@janitor/cluster/GitHub/ReadModel/GitHubReadModel", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new GitHubReadModelError({ operation, message: describeError(error) }),
        )

    const applyInstallation = Effect.fn("GitHubReadModel.applyInstallation")(function* ({
      installation,
      status,
      sequence,
    }: InstallationObservation) {
      const account = installation.account
      const accountHandle = account.type === "Enterprise" ? account.slug : account.login
      yield* sql`
        INSERT INTO github_installation ${sql.insert({
          installation_id: installation.id,
          account_database_id: account.id,
          account_handle: accountHandle,
          account_type: account.type,
          repository_selection: installation.repositorySelection,
          status,
          html_url: installation.htmlUrl,
          projected_sequence: sequence,
        })}
        ON CONFLICT (installation_id) DO UPDATE SET
          account_database_id = EXCLUDED.account_database_id,
          account_handle = EXCLUDED.account_handle,
          account_type = EXCLUDED.account_type,
          repository_selection = EXCLUDED.repository_selection,
          status = EXCLUDED.status,
          html_url = EXCLUDED.html_url,
          projected_sequence = EXCLUDED.projected_sequence,
          observed_at = CLOCK_TIMESTAMP()
        WHERE github_installation.projected_sequence < EXCLUDED.projected_sequence
      `.pipe(wrap("applyInstallation"))
    })

    const applyRepositories = Effect.fn("GitHubReadModel.applyRepositories")(function* ({
      installationId,
      repositories,
      sequence,
    }: RepositoriesObservation) {
      for (const repository of repositories) {
        yield* sql`
          INSERT INTO github_repository ${sql.insert({
            repository_id: repository.id,
            node_id: repository.nodeId ?? null,
            installation_id: installationId,
            owner: repository.fullName.owner,
            repo: repository.fullName.repo,
            is_private: repository.isPrivate,
            access: "accessible",
            projected_sequence: sequence,
          })}
          ON CONFLICT (repository_id) DO UPDATE SET
            node_id = COALESCE(EXCLUDED.node_id, github_repository.node_id),
            installation_id = EXCLUDED.installation_id,
            owner = EXCLUDED.owner,
            repo = EXCLUDED.repo,
            is_private = EXCLUDED.is_private,
            access = 'accessible',
            projected_sequence = EXCLUDED.projected_sequence,
            observed_at = CLOCK_TIMESTAMP()
          WHERE github_repository.projected_sequence < EXCLUDED.projected_sequence
        `.pipe(wrap("applyRepositories"))
      }
    })

    const markRepositoriesLost = Effect.fn("GitHubReadModel.markRepositoriesLost")(function* ({
      installationId,
      repositories,
      sequence,
    }: RepositoriesObservation) {
      if (repositories.length === 0) return
      yield* sql`
        UPDATE github_repository
        SET access = 'lost', projected_sequence = ${sequence}, observed_at = CLOCK_TIMESTAMP()
        WHERE installation_id = ${installationId}
          AND repository_id IN ${sql.in(repositories.map((repository) => repository.id))}
          AND projected_sequence < ${sequence}
      `.pipe(wrap("markRepositoriesLost"))
    })

    const markRepositoriesSuspect = Effect.fn("GitHubReadModel.markRepositoriesSuspect")(
      function* ({ installationId, present, sequence }: RepositoriesPresence) {
        const exclusion =
          present.length === 0 ? sql`` : sql`AND repository_id NOT IN ${sql.in(present)}`
        yield* sql`
        UPDATE github_repository
        SET access = 'suspect', projected_sequence = ${sequence}, observed_at = CLOCK_TIMESTAMP()
        WHERE installation_id = ${installationId}
          AND access = 'accessible'
          AND projected_sequence <= ${sequence}
          ${exclusion}
      `.pipe(wrap("markRepositoriesSuspect"))
      },
    )

    const applyPullRequest = Effect.fn("GitHubReadModel.applyPullRequest")(function* ({
      installationId,
      repository,
      pullRequest,
      sequence,
    }: PullRequestObservation) {
      // Ensure the repository row exists so foreign relationships hold. Access
      // and privacy are unknown from a pull request event, so an existing row
      // keeps its values and a new row records privacy as unknown.
      yield* sql`
        INSERT INTO github_repository ${sql.insert({
          repository_id: repository.id,
          node_id: repository.nodeId ?? null,
          installation_id: installationId,
          owner: repository.fullName.owner,
          repo: repository.fullName.repo,
          is_private: null,
          access: "accessible",
          projected_sequence: sequence,
        })}
        ON CONFLICT (repository_id) DO UPDATE SET
          node_id = COALESCE(EXCLUDED.node_id, github_repository.node_id),
          owner = EXCLUDED.owner,
          repo = EXCLUDED.repo,
          observed_at = CLOCK_TIMESTAMP()
        WHERE github_repository.projected_sequence < EXCLUDED.projected_sequence
      `.pipe(wrap("applyPullRequest"))

      const updated = yield* sql`
        INSERT INTO github_entity ${sql.insert({
          repository_id: repository.id,
          number: pullRequest.number,
          kind: "pull_request",
          title: pullRequest.title,
          body: pullRequest.body,
          author_login: pullRequest.user.login,
          author_id: pullRequest.user.id ?? null,
          state: pullRequest.state,
          github_updated_at: DateTime.toDateUtc(pullRequest.updatedAt),
          projected_sequence: sequence,
        })}
        ON CONFLICT (repository_id, number) DO UPDATE SET
          kind = EXCLUDED.kind,
          title = EXCLUDED.title,
          body = EXCLUDED.body,
          author_login = EXCLUDED.author_login,
          author_id = COALESCE(EXCLUDED.author_id, github_entity.author_id),
          state = EXCLUDED.state,
          github_updated_at = EXCLUDED.github_updated_at,
          projected_sequence = EXCLUDED.projected_sequence,
          observed_at = CLOCK_TIMESTAMP()
        WHERE github_entity.github_updated_at < EXCLUDED.github_updated_at
           OR (github_entity.github_updated_at = EXCLUDED.github_updated_at
               AND github_entity.projected_sequence < EXCLUDED.projected_sequence)
        RETURNING number
      `.pipe(wrap("applyPullRequest"))

      if (updated.length === 0) {
        return { _tag: "Stale" } as const
      }

      yield* sql`
        INSERT INTO github_pull_request ${sql.insert({
          repository_id: repository.id,
          number: pullRequest.number,
          pull_request_id: pullRequest.id,
          pull_request_node_id: pullRequest.nodeId,
          base_ref: pullRequest.base.ref,
          draft: pullRequest.draft,
          head_sha: pullRequest.head.sha,
          merged: pullRequest.merged,
        })}
        ON CONFLICT (repository_id, number) DO UPDATE SET
          pull_request_id = EXCLUDED.pull_request_id,
          pull_request_node_id = EXCLUDED.pull_request_node_id,
          base_ref = EXCLUDED.base_ref,
          draft = EXCLUDED.draft,
          head_sha = EXCLUDED.head_sha,
          merged = EXCLUDED.merged
      `.pipe(wrap("applyPullRequest"))

      for (const label of pullRequest.labels) {
        yield* sql`
          INSERT INTO github_label ${sql.insert({
            repository_id: repository.id,
            label_id: label.id,
            node_id: label.nodeId ?? null,
            name: label.name,
            availability: "available",
            projected_sequence: sequence,
          })}
          ON CONFLICT (repository_id, label_id) DO UPDATE SET
            node_id = COALESCE(EXCLUDED.node_id, github_label.node_id),
            name = EXCLUDED.name,
            availability = 'available',
            projected_sequence = EXCLUDED.projected_sequence,
            observed_at = CLOCK_TIMESTAMP()
          WHERE github_label.projected_sequence < EXCLUDED.projected_sequence
        `.pipe(wrap("applyPullRequest"))
      }

      // The payload carries the complete label set as of updated_at, so replace.
      yield* sql`
        DELETE FROM github_entity_label
        WHERE repository_id = ${repository.id} AND number = ${pullRequest.number}
      `.pipe(wrap("applyPullRequest"))
      if (pullRequest.labels.length > 0) {
        yield* sql`
          INSERT INTO github_entity_label ${sql.insert(
            pullRequest.labels.map((label) => ({
              repository_id: repository.id,
              number: pullRequest.number,
              label_id: label.id,
            })),
          )}
          ON CONFLICT DO NOTHING
        `.pipe(wrap("applyPullRequest"))
      }

      return { _tag: "Applied" } as const
    })

    const upsertLabels = (
      repositoryId: GitHubRepositoryDatabaseId,
      labels: ReadonlyArray<{
        readonly id: string
        readonly nodeId?: string | undefined
        readonly name: string
      }>,
      sequence: GitHubWebhookJournalSequence,
      operation: string,
    ) =>
      Effect.forEach(
        labels,
        (label) =>
          sql`
            INSERT INTO github_label ${sql.insert({
              repository_id: repositoryId,
              label_id: label.id,
              node_id: label.nodeId ?? null,
              name: label.name,
              availability: "available",
              projected_sequence: sequence,
            })}
            ON CONFLICT (repository_id, label_id) DO UPDATE SET
              node_id = COALESCE(EXCLUDED.node_id, github_label.node_id),
              name = EXCLUDED.name,
              availability = 'available',
              projected_sequence = EXCLUDED.projected_sequence,
              observed_at = CLOCK_TIMESTAMP()
            WHERE github_label.projected_sequence <= EXCLUDED.projected_sequence
          `.pipe(wrap(operation)),
        { discard: true },
      )

    const replaceEntityLabels = (
      repositoryId: GitHubRepositoryDatabaseId,
      number: number,
      labelIds: ReadonlyArray<string>,
      operation: string,
    ) =>
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM github_entity_label WHERE repository_id = ${repositoryId} AND number = ${number}
        `.pipe(wrap(operation))
        if (labelIds.length > 0) {
          yield* sql`
            INSERT INTO github_entity_label ${sql.insert(
              labelIds.map((labelId) => ({
                repository_id: repositoryId,
                number,
                label_id: labelId,
              })),
            )}
            ON CONFLICT DO NOTHING
          `.pipe(wrap(operation))
        }
      })

    const applyLabelCatalog = Effect.fn("GitHubReadModel.applyLabelCatalog")(function* ({
      repositoryId,
      labels,
      sequence,
    }: LabelCatalogObservation) {
      yield* upsertLabels(repositoryId, labels, sequence, "applyLabelCatalog")
      const exclusion =
        labels.length === 0
          ? sql``
          : sql`AND label_id NOT IN ${sql.in(labels.map((label) => label.id))}`
      yield* sql`
        UPDATE github_label
        SET availability = 'suspect', projected_sequence = ${sequence}, observed_at = CLOCK_TIMESTAMP()
        WHERE repository_id = ${repositoryId}
          AND availability = 'available'
          AND projected_sequence <= ${sequence}
          ${exclusion}
      `.pipe(wrap("applyLabelCatalog"))
    })

    const applyIssue = Effect.fn("GitHubReadModel.applyIssue")(function* ({
      repositoryId,
      issue,
      sequence,
    }: IssueObservation) {
      const updated = yield* sql`
        INSERT INTO github_entity ${sql.insert({
          repository_id: repositoryId,
          number: issue.number,
          kind: issue.pullRequest === undefined ? "issue" : "pull_request",
          issue_id: issue.id,
          issue_node_id: issue.nodeId,
          title: issue.title,
          body: issue.body,
          author_login: issue.user?.login ?? "ghost",
          author_id: issue.user?.id ?? null,
          state: issue.state,
          github_updated_at: DateTime.toDateUtc(issue.updatedAt),
          projected_sequence: sequence,
        })}
        ON CONFLICT (repository_id, number) DO UPDATE SET
          kind = EXCLUDED.kind,
          issue_id = EXCLUDED.issue_id,
          issue_node_id = EXCLUDED.issue_node_id,
          title = EXCLUDED.title,
          body = EXCLUDED.body,
          author_login = EXCLUDED.author_login,
          author_id = COALESCE(EXCLUDED.author_id, github_entity.author_id),
          state = EXCLUDED.state,
          github_updated_at = EXCLUDED.github_updated_at,
          projected_sequence = EXCLUDED.projected_sequence,
          observed_at = CLOCK_TIMESTAMP()
        WHERE github_entity.github_updated_at < EXCLUDED.github_updated_at
           OR (github_entity.github_updated_at = EXCLUDED.github_updated_at
               AND github_entity.projected_sequence <= EXCLUDED.projected_sequence)
        RETURNING number
      `.pipe(wrap("applyIssue"))
      if (updated.length === 0) {
        return { _tag: "Stale" } as const
      }
      yield* upsertLabels(repositoryId, issue.labels, sequence, "applyIssue")
      yield* replaceEntityLabels(
        repositoryId,
        issue.number,
        issue.labels.map((label) => label.id),
        "applyIssue",
      )
      return { _tag: "Applied" } as const
    })

    const applyPullRequestDetails = Effect.fn("GitHubReadModel.applyPullRequestDetails")(
      function* ({ repositoryId, pullRequest, sequence }: PullRequestDetailsObservation) {
        const merged = pullRequest.merged ?? pullRequest.mergedAt !== null
        // The entity scan owns the github_entity row; details for a number it has
        // not seen yet are skipped rather than violating the foreign key.
        const rows = yield* sql`
        INSERT INTO github_pull_request
          (repository_id, number, pull_request_id, pull_request_node_id, base_ref, draft, head_sha, merged)
        SELECT ${repositoryId}, ${pullRequest.number}, ${pullRequest.id}, ${pullRequest.nodeId},
               ${pullRequest.base.ref}, ${pullRequest.draft}, ${pullRequest.head.sha}, ${merged}
        WHERE EXISTS (
          SELECT 1 FROM github_entity e
          WHERE e.repository_id = ${repositoryId} AND e.number = ${pullRequest.number}
        )
        ON CONFLICT (repository_id, number) DO UPDATE SET
          pull_request_id = EXCLUDED.pull_request_id,
          pull_request_node_id = EXCLUDED.pull_request_node_id,
          base_ref = EXCLUDED.base_ref,
          draft = EXCLUDED.draft,
          head_sha = EXCLUDED.head_sha,
          merged = EXCLUDED.merged
        WHERE EXISTS (
          SELECT 1 FROM github_entity e
          WHERE e.repository_id = EXCLUDED.repository_id AND e.number = EXCLUDED.number
            AND e.github_updated_at <= ${DateTime.toDateUtc(pullRequest.updatedAt)}
        )
        RETURNING number
      `.pipe(wrap("applyPullRequestDetails"))
        void sequence
        return rows.length === 0 ? ({ _tag: "Unknown" } as const) : ({ _tag: "Applied" } as const)
      },
    )

    const getInstallation = Effect.fn("GitHubReadModel.getInstallation")(function* (
      installationId: GitHubInstallationId,
    ) {
      const rows = yield* sql`
        SELECT * FROM github_installation WHERE installation_id = ${installationId}
      `.pipe(Effect.flatMap(rowsToRecords(InstallationRow)), wrap("getInstallation"))
      const row = rows[0]
      if (row === undefined) return Option.none()
      const record: GitHubInstallationRecord = {
        installationId: row.installation_id,
        accountDatabaseId: row.account_database_id,
        accountHandle: row.account_handle,
        accountType: row.account_type,
        repositorySelection: row.repository_selection,
        status: row.status,
        htmlUrl: row.html_url,
        projectedSequence: sequenceOf(row.projected_sequence),
        observedAt: row.observed_at,
      }
      return Option.some(record)
    })

    const getRepository = Effect.fn("GitHubReadModel.getRepository")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      const rows = yield* sql`
        SELECT * FROM github_repository WHERE repository_id = ${repositoryId}
      `.pipe(Effect.flatMap(rowsToRecords(RepositoryRow)), wrap("getRepository"))
      const row = rows[0]
      if (row === undefined) return Option.none()
      const record: GitHubRepositoryRecord = {
        repositoryId: row.repository_id,
        nodeId: row.node_id,
        installationId: row.installation_id,
        owner: row.owner,
        repo: row.repo,
        isPrivate: row.is_private,
        access: row.access,
        enabled: row.enabled,
        projectedSequence: sequenceOf(row.projected_sequence),
        observedAt: row.observed_at,
      }
      return Option.some(record)
    })

    const getEntity = Effect.fn("GitHubReadModel.getEntity")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      number: number,
    ) {
      const entities = yield* sql`
        SELECT * FROM github_entity WHERE repository_id = ${repositoryId} AND number = ${number}
      `.pipe(Effect.flatMap(rowsToRecords(EntityRow)), wrap("getEntity"))
      const row = entities[0]
      if (row === undefined) return Option.none()
      const pullRequests = yield* sql`
        SELECT * FROM github_pull_request WHERE repository_id = ${repositoryId} AND number = ${number}
      `.pipe(Effect.flatMap(rowsToRecords(PullRequestRow)), wrap("getEntity"))
      const labels = yield* sql`
        SELECT * FROM github_entity_label WHERE repository_id = ${repositoryId} AND number = ${number}
        ORDER BY label_id
      `.pipe(Effect.flatMap(rowsToRecords(EntityLabelRow)), wrap("getEntity"))
      const entity: GitHubEntityRecord = {
        repositoryId: row.repository_id,
        number: row.number,
        kind: row.kind,
        issueId: row.issue_id,
        issueNodeId: row.issue_node_id,
        title: row.title,
        body: row.body,
        authorLogin: row.author_login,
        authorId: row.author_id,
        state: row.state,
        githubUpdatedAt: row.github_updated_at,
        projectedSequence: sequenceOf(row.projected_sequence),
        observedAt: row.observed_at,
      }
      const pullRequest = Option.map(
        Option.fromNullishOr(pullRequests[0]),
        (pr): GitHubPullRequestRecord => ({
          repositoryId: pr.repository_id,
          number: pr.number,
          pullRequestId: pr.pull_request_id,
          pullRequestNodeId: pr.pull_request_node_id,
          baseRef: pr.base_ref,
          draft: pr.draft,
          headSha: pr.head_sha,
          merged: pr.merged,
        }),
      )
      return Option.some({
        entity,
        pullRequest,
        labels: labels.map((label): GitHubEntityLabelRecord => ({
          repositoryId: label.repository_id,
          number: label.number,
          labelId: label.label_id,
        })),
      })
    })

    const listLabels = Effect.fn("GitHubReadModel.listLabels")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      const rows = yield* sql`
        SELECT * FROM github_label WHERE repository_id = ${repositoryId} ORDER BY label_id
      `.pipe(Effect.flatMap(rowsToRecords(LabelRow)), wrap("listLabels"))
      return rows.map((row): GitHubLabelRecord => ({
        repositoryId: row.repository_id,
        labelId: row.label_id,
        nodeId: row.node_id,
        name: row.name,
        availability: row.availability,
        projectedSequence: sequenceOf(row.projected_sequence),
        observedAt: row.observed_at,
      }))
    })

    const withTransaction = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | GitHubReadModelError, R> =>
      sql.withTransaction(effect).pipe(
        Effect.mapError((error) =>
          SqlError.isSqlError(error)
            ? new GitHubReadModelError({
                operation: "withTransaction",
                message: describeError(error),
              })
            : error,
        ),
      )

    return {
      withTransaction,
      applyInstallation,
      applyRepositories,
      markRepositoriesLost,
      markRepositoriesSuspect,
      applyPullRequest,
      applyLabelCatalog,
      applyIssue,
      applyPullRequestDetails,
      getInstallation,
      getRepository,
      getEntity,
      listLabels,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
