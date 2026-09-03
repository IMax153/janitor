/**
 * One-off operator script: enable (or disable) a repository for syncing and
 * bootstrap its tracks. Usage:
 *
 *   DATABASE_URL=postgres://... node apps/cluster/scripts/EnableRepository.ts <repository_id> [true|false]
 */
import * as PgClient from "@effect/sql-pg/PgClient"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { SyncPlanner } from "../src/SyncPlanner.ts"
import { SyncTargets } from "../src/SyncTargets.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"

const Database = Layer.unwrap(
  Effect.map(Config.schema(Schema.Redacted(Schema.String), "DATABASE_URL"), (url) =>
    PgClient.layer({ url }),
  ),
)

const Services = SyncPlanner.layer.pipe(
  Layer.provide(SyncTargets.layer.pipe(Layer.provide(WorkflowOutbox.layer))),
  Layer.provideMerge(Database),
)

const program = Effect.gen(function* () {
  const repositoryId = yield* Schema.decodeUnknownEffect(GitHubRepositoryDatabaseId)(
    process.argv[2],
  )
  const enabled = (process.argv[3] ?? "true") === "true"
  const planner = yield* SyncPlanner
  yield* planner.setRepositoryEnabled(repositoryId, enabled)
  yield* Effect.log(`repository ${repositoryId} enabled=${enabled}`)
})

Effect.runPromise(program.pipe(Effect.provide(Services), Effect.scoped)).catch((error) => {
  console.error(error)
  process.exit(1)
})
