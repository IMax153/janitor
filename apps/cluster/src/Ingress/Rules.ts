import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { ReconciliationRecord, RepositoryOverview } from "@janitor/domain/Labeling/Reconciliation"
import { RulesetIssue, RulesetView, SaveRulesetRequest } from "@janitor/domain/Labeling/Ruleset"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { LabelingOverview } from "../Labeling/Overview.ts"
import { LabelingRulesets } from "../Labeling/Rulesets.ts"
import { CurrentAccessIdentity } from "./Middleware.ts"
import { SameOriginMiddleware } from "./Sync.ts"

const PathParams = Schema.Struct({ repositoryId: GitHubRepositoryDatabaseId })
const decodePath = HttpRouter.schemaPathParams(PathParams)
const decodeBody = HttpServerRequest.schemaBodyJson(SaveRulesetRequest)

const respondView = HttpServerResponse.schemaJson(RulesetView)
const respondRepositories = HttpServerResponse.schemaJson(Schema.Array(RepositoryOverview))
const respondReconciliations = HttpServerResponse.schemaJson(Schema.Array(ReconciliationRecord))
const respondIssues = HttpServerResponse.schemaJson(
  Schema.Struct({ issues: Schema.Array(RulesetIssue) }),
)

const badRequestResponse = HttpServerResponse.text("Bad Request", { status: 400 })
const notFoundResponse = HttpServerResponse.empty({ status: 404 })
const serviceUnavailableResponse = HttpServerResponse.text("Service Unavailable", {
  status: 503,
  headers: { "Retry-After": "10" },
})

const unavailable = (operation: string) =>
  Effect.fnUntraced(function* (cause: unknown) {
    yield* Effect.logError(`Ruleset ${operation} failed`, cause)
    return serviceUnavailableResponse
  })

/**
 * Auto-labeling configuration (design: "Configuration API"). Both routes sit
 * behind the Access assertion check; the save additionally requires a
 * same-origin browser request and names the revision it edited.
 */
export const RulesetLoadRoute = HttpRouter.add(
  "GET",
  "/repositories/:repositoryId/rules",
  Effect.gen(function* () {
    const { repositoryId } = yield* decodePath
    const rulesets = yield* LabelingRulesets
    return yield* respondView(yield* rulesets.load(repositoryId))
  }).pipe(
    Effect.catchTags({
      SchemaError: () => Effect.succeed(badRequestResponse),
      RepositoryNotFound: () => Effect.succeed(notFoundResponse),
    }),
    Effect.catchCause(unavailable("load")),
  ),
)

export const RulesetSaveRoute = HttpRouter.add(
  "PUT",
  "/repositories/:repositoryId/rules",
  Effect.gen(function* () {
    const { repositoryId } = yield* decodePath
    const body = yield* decodeBody
    const identity = yield* CurrentAccessIdentity
    const rulesets = yield* LabelingRulesets
    const view = yield* rulesets.save({
      repositoryId,
      expectedRevision: body.expectedRevision,
      ruleset: body.ruleset,
      author: { issuer: identity.issuer, subject: identity.subject },
    })
    return yield* respondView(view)
  }).pipe(
    Effect.catchTags({
      SchemaError: () => Effect.succeed(badRequestResponse),
      HttpServerError: () => Effect.succeed(badRequestResponse),
      RepositoryNotFound: () => Effect.succeed(notFoundResponse),
      RulesetConflict: (error) => respondView(error.current, { status: 409 }),
      RulesetInvalid: (error) => respondIssues({ issues: error.issues }, { status: 422 }),
    }),
    Effect.catchCause(unavailable("save")),
  ),
).pipe(Layer.provide(SameOriginMiddleware))

export const RepositoriesRoute = HttpRouter.add(
  "GET",
  "/repositories",
  Effect.gen(function* () {
    const overview = yield* LabelingOverview
    return yield* respondRepositories(yield* overview.repositories)
  }).pipe(Effect.catchCause(unavailable("repositories"))),
)

export const ReconciliationsRoute = HttpRouter.add(
  "GET",
  "/repositories/:repositoryId/reconciliations",
  Effect.gen(function* () {
    const { repositoryId } = yield* decodePath
    const overview = yield* LabelingOverview
    return yield* respondReconciliations(yield* overview.reconciliations(repositoryId))
  }).pipe(
    Effect.catchTag("SchemaError", () => Effect.succeed(badRequestResponse)),
    Effect.catchCause(unavailable("reconciliations")),
  ),
)

export const RulesRoutesLayer = Layer.mergeAll(
  RulesetLoadRoute,
  RulesetSaveRoute,
  RepositoriesRoute,
  ReconciliationsRoute,
)
