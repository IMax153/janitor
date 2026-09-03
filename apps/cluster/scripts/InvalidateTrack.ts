// Debug helper: request a new generation for a repository track. Usage: <repository_id> <track> [full]
import * as PgClient from "@effect/sql-pg/PgClient"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { SyncTargets } from "../src/SyncTargets.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"
const Database = Layer.unwrap(
  Effect.map(Config.schema(Schema.Redacted(Schema.String), "DATABASE_URL"), (url) =>
    PgClient.layer({ url }),
  ),
)
const program = Effect.gen(function* () {
  const repositoryId = yield* Schema.decodeUnknownEffect(GitHubRepositoryDatabaseId)(
    process.argv[2],
  )
  const track = process.argv[3] as "labels" | "entities" | "pull_requests"
  const targets = yield* SyncTargets
  const result = yield* targets.invalidate({
    scope: { _tag: "RepositoryTrack", repositoryId, track },
    sequence: Option.none(),
    full: process.argv[4] === "full",
  })
  yield* Effect.log(
    `invalidated ${track}: generation ${result.generation} dispatched=${result.dispatched}`,
  )
})
Effect.runPromise(
  program.pipe(
    Effect.provide(
      SyncTargets.layer.pipe(Layer.provide(WorkflowOutbox.layer), Layer.provideMerge(Database)),
    ),
    Effect.scoped,
  ),
).catch((e) => {
  console.error(String(e).slice(0, 1500))
  process.exit(1)
})
