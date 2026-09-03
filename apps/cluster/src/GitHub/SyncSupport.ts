import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { type SyncGeneration, type SyncScope, syncScopeKey } from "@janitor/domain/GitHub/Sync"
import * as Cause from "effect/Cause"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as DurableClock from "effect/unstable/workflow/DurableClock"
import { GITHUB_API_BASE_URL, gitHubApiScopeKey } from "@janitor/domain/GitHub/Api"
import { SyncTargets, type SyncOutcome } from "../SyncTargets.ts"
import { GitHubHttpCache } from "./HttpCache.ts"
import { nextLink } from "./Link.ts"
import { GitHubReadModel } from "./ReadModel.ts"
import {
  GitHubTransport,
  type GitHubRequest,
  type GitHubResponse,
  type GitHubTransportFailure,
} from "./Transport.ts"
import { RulesetActivation } from "../Labeling/Activation.ts"
import { backfillAfterActivation } from "../Labeling/SnapshotHandoff.ts"

export const SyncRunOutcome = Schema.Literals(["verified", "blocked", "failed", "superseded"])
export type SyncRunOutcome = typeof SyncRunOutcome.Type

/** GitHub asked us to wait. The workflow sleeps durably and retries the activity. */
export class SyncRateLimited extends Schema.TaggedError<SyncRateLimited>()("SyncRateLimited", {
  until: Schema.DateTimeUtcFromString,
}) {}

export class SyncActivityError extends Schema.TaggedError<SyncActivityError>()(
  "SyncActivityError",
  {
    message: Schema.String,
  },
) {}

export const SyncActivityFailure = Schema.Union([SyncRateLimited, SyncActivityError])

export const failure = (message: string) => new SyncActivityError({ message })

export const describeFailed = (response: Extract<GitHubResponse, { _tag: "Failed" }>) =>
  `GitHub responded ${response.status}` +
  (Option.isSome(response.requestId) ? ` (request ${response.requestId.value})` : "")

export const rateLimitedOrFailure = <A, R>(effect: Effect.Effect<A, GitHubTransportFailure, R>) =>
  Effect.mapError(effect, (error): SyncRateLimited | SyncActivityError =>
    error._tag === "GitHubRateLimited"
      ? new SyncRateLimited({ until: error.until })
      : failure(error.message),
  )

const MAX_RATE_LIMIT_WAITS = 24

/**
 * Runs `make(attempt)` and, when GitHub rate limits it, sleeps on a uniquely
 * named durable clock until the budget says to try again. Each attempt is its
 * own activity so a replay after eviction resumes at the right step.
 */
export const withRateLimitWaits = <A, R>(
  name: string,
  make: (attempt: number) => Effect.Effect<A, SyncRateLimited | SyncActivityError, R>,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < MAX_RATE_LIMIT_WAITS; attempt++) {
      const result = yield* make(attempt).pipe(Effect.result)
      if (result._tag === "Success") {
        return result.success
      }
      if (result.failure._tag === "SyncActivityError") {
        return yield* result.failure
      }
      const now = yield* DateTime.now
      const wait = Duration.max(
        Duration.millis(DateTime.toEpochMillis(result.failure.until) - DateTime.toEpochMillis(now)),
        Duration.seconds(1),
      )
      yield* DurableClock.sleep({ name: `${name}/wait-${attempt}`, duration: wait })
    }
    return yield* failure(`Rate limited ${MAX_RATE_LIMIT_WAITS} times while running ${name}`)
  })

export interface CacheOptions {
  /** Lets access-loss purges remove pages holding this repository's content. */
  readonly repositoryId: Option.Option<GitHubRepositoryDatabaseId>
}

const absoluteUrl = (url: string) =>
  url.startsWith("https://") ? url : `${GITHUB_API_BASE_URL}${url}`

/**
 * Sends one request through the transport and decodes a 200 body with
 * `schema`. With `cache`, the stored ETag makes the request conditional and a
 * `304` serves the stored representation, which still validates only that
 * exact page.
 */
export const fetchJson = <S extends Schema.Top>(
  request: GitHubRequest,
  schema: S,
  cache?: CacheOptions,
) =>
  Effect.gen(function* () {
    const transport = yield* GitHubTransport
    const httpCache = yield* GitHubHttpCache
    const key = {
      scopeKey: gitHubApiScopeKey(request.scope),
      method: request.method,
      url: absoluteUrl(request.url),
    }
    const cached =
      cache === undefined
        ? Option.none()
        : yield* httpCache.get(key).pipe(Effect.mapError((error) => failure(error.message)))
    const response = yield* transport
      .request({
        ...request,
        etag: Option.getOrUndefined(Option.map(cached, (entry) => entry.etag)),
      })
      .pipe(rateLimitedOrFailure)
    switch (response._tag) {
      case "Ok": {
        const body = yield* Schema.decodeUnknownEffect(schema)(response.body).pipe(
          Effect.mapError((error) => failure(`${request.url} did not decode: ${error.message}`)),
        )
        const next = Option.flatMap(response.link, nextLink)
        if (cache !== undefined && Option.isSome(response.etag)) {
          yield* httpCache
            .put({
              ...key,
              etag: response.etag.value,
              body: response.body,
              next,
              repositoryId: cache.repositoryId,
            })
            .pipe(Effect.mapError((error) => failure(error.message)))
        }
        return { _tag: "Ok" as const, body, next, fromCache: false }
      }
      case "NotModified": {
        if (Option.isNone(cached)) {
          return yield* failure("Unexpected 304 without a conditional request")
        }
        const body = yield* Schema.decodeUnknownEffect(schema)(cached.value.body).pipe(
          Effect.mapError((error) =>
            failure(`${request.url} cached page did not decode: ${error.message}`),
          ),
        )
        return { _tag: "Ok" as const, body, next: cached.value.next, fromCache: true }
      }
      case "Failed":
        return {
          _tag: "Failed" as const,
          status: response.status,
          message: describeFailed(response),
        }
    }
  })

/** The URL of the page after `url`, for probing beyond a formerly full final page. */
export const probeUrl = (url: string): string => {
  const parsed = new URL(absoluteUrl(url))
  const page = Number(parsed.searchParams.get("page") ?? "1")
  parsed.searchParams.set("page", String(Number.isFinite(page) && page > 0 ? page + 1 : 2))
  return parsed.toString()
}

export const PAGE_SIZE = 100

export const MAX_PAGES = 200

export interface PageResult<A> {
  readonly items: ReadonlyArray<A>
  readonly next: string | null
}

/**
 * Follows `Link: rel="next"` from `firstUrl`, running one uniquely named
 * activity per page. Returns every item, or a failure describing the page.
 */
export const paginate = <A, S extends Schema.Top>(options: {
  readonly name: string
  readonly firstUrl: string
  readonly request: Omit<GitHubRequest, "url" | "method">
  readonly page: S
  readonly items: (body: S["Type"]) => ReadonlyArray<A>
  readonly itemSchema: Schema.Codec<A, unknown>
  readonly onFailed?: ((status: number) => SyncRunOutcome | undefined) | undefined
  readonly cache?: CacheOptions | undefined
}) =>
  Effect.gen(function* () {
    const collected: Array<A> = []
    let next: string | null = options.firstUrl
    const pageSchema = Schema.Struct({
      items: Schema.Array(options.itemSchema),
      next: Schema.NullOr(Schema.String),
    })
    for (let ordinal = 0; next !== null && ordinal < MAX_PAGES; ordinal++) {
      const url: string = next
      const result = yield* withRateLimitWaits(`${options.name}/${ordinal}`, (attempt) =>
        Activity.make({
          name: `${options.name}/${ordinal}/${attempt}`,
          success: Schema.Union([
            Schema.TaggedStruct("Page", pageSchema.fields),
            Schema.TaggedStruct("Failed", { status: Schema.Int, message: Schema.String }),
          ]),
          error: SyncActivityFailure,
          execute: Effect.gen(function* () {
            const response = yield* fetchJson(
              { ...options.request, method: "GET", url },
              options.page,
              options.cache,
            )
            if (response._tag === "Failed") {
              return { _tag: "Failed" as const, status: response.status, message: response.message }
            }
            const items = options.items(response.body)
            // A 304 on a page that was full when stored proves nothing about
            // pages after it, so probe one further rather than trust the cached end.
            const next =
              response.fromCache && Option.isNone(response.next) && items.length >= PAGE_SIZE
                ? Option.some(probeUrl(url))
                : response.next
            return { _tag: "Page" as const, items, next: Option.getOrNull(next) }
          }),
        }),
      ).pipe(Effect.result)
      if (result._tag === "Failure") {
        return { _tag: "Failed" as const, message: result.failure.message }
      }
      if (result.success._tag === "Failed") {
        const blocked = options.onFailed?.(result.success.status)
        return blocked === "blocked"
          ? { _tag: "Blocked" as const, reason: `http-${result.success.status}` }
          : { _tag: "Failed" as const, message: result.success.message }
      }
      collected.push(...result.success.items)
      next = result.success.next
    }
    if (next !== null) {
      return { _tag: "Failed" as const, message: `${options.name} exceeded ${MAX_PAGES} pages` }
    }
    return { _tag: "Complete" as const, items: collected as ReadonlyArray<A> }
  })

/** Records the run outcome on the target inside its own activity. */
export const completeRun = (
  name: string,
  scope: SyncScope,
  generation: SyncGeneration,
  outcome: SyncOutcome,
) =>
  Activity.make({
    name: `${name}/Complete/${outcome._tag}`,
    error: SyncActivityError,
    execute: Effect.gen(function* () {
      const targets = yield* SyncTargets
      const accepted = yield* targets
        .complete({ scope, generation, outcome })
        .pipe(Effect.mapError((error) => failure(error.message)))
      // A verified repository track may be the last one a saved ruleset
      // revision was waiting on. Optional so tests without labeling still run.
      if (outcome._tag === "Verified" && scope._tag === "RepositoryTrack") {
        const activation = yield* Effect.serviceOption(RulesetActivation)
        if (Option.isSome(activation)) {
          const promoted = yield* activation.value
            .promote(scope.repositoryId)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Ruleset promotion after track verification failed", cause).pipe(
                  Effect.as(Option.none()),
                ),
              ),
            )
          if (Option.isSome(promoted)) yield* backfillAfterActivation(scope.repositoryId)
        }
      }
      const detail =
        outcome._tag === "Failed"
          ? outcome.error
          : outcome._tag === "Blocked"
            ? outcome.reason
            : undefined
      yield* Effect.logWithLevel(outcome._tag === "Verified" ? "Info" : "Warn")(
        "Completed GitHub sync run",
      ).pipe(
        Effect.annotateLogs({
          workflow: name,
          scope: syncScopeKey(scope),
          generation,
          outcome: outcome._tag,
          accepted,
          ...(detail === undefined ? {} : { detail }),
        }),
      )
    }),
  })

/**
 * Asks for another generation of the same scope. The run in flight blocks
 * dispatch, so completion enqueues the follow-up once this run's generation
 * is recorded.
 */
export const requestFollowUp = (name: string, scope: SyncScope) =>
  Activity.make({
    name: `${name}/FollowUp`,
    error: SyncActivityError,
    execute: Effect.gen(function* () {
      const targets = yield* SyncTargets
      yield* targets
        .invalidate({ scope, sequence: Option.none() })
        .pipe(Effect.mapError((error) => failure(error.message)))
    }),
  })

/**
 * Workflow bodies run inside the engine, which records a failed exit without
 * surfacing it. Log the cause so a dead run is visible in Worker logs.
 */
export const logWorkflowFailure =
  (name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.tapCause(effect, (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError(`${name} workflow failed`, cause).pipe(
            Effect.annotateLogs({ workflow: name }),
          ),
    )

/** Resolves the repository a track belongs to, or the reason it cannot be scanned. */
export const resolveRepository = (repositoryId: GitHubRepositoryDatabaseId) =>
  Effect.gen(function* () {
    const readModel = yield* GitHubReadModel
    const repository = yield* readModel
      .getRepository(repositoryId)
      .pipe(Effect.mapError((error) => failure(error.message)))
    if (Option.isNone(repository)) {
      return { _tag: "Blocked" as const, reason: "repository-unknown" }
    }
    if (repository.value.access !== "accessible") {
      return { _tag: "Blocked" as const, reason: `repository-access-${repository.value.access}` }
    }
    return { _tag: "Found" as const, repository: repository.value }
  })
