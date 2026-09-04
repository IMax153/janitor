import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Docker from "alchemy/Docker"
import * as Command from "alchemy/Command"
import * as Neon from "alchemy/Neon"
import * as Output from "alchemy/Output"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

const LocalDatabasePassword = Redacted.make("janitor")

const LocalDatabase = Effect.gen(function* () {
  const image = yield* Docker.Image("PostgresImage", {
    build: {
      context: "apps/cluster",
      dockerfile: "docker/postgres/Dockerfile",
    },
  })

  const container = yield* Docker.Container("Postgres", {
    image,
    environment: {
      POSTGRES_DB: "janitor",
      POSTGRES_USER: "janitor",
      POSTGRES_PASSWORD: LocalDatabasePassword,
    },
    ports: [{ external: 0, internal: 5432 }],
    healthcheck: {
      cmd: "pg_isready --username janitor --dbname janitor",
      interval: "1 second",
      timeout: "3 seconds",
      retries: 30,
    },
    start: true,
  })

  const origin: Alchemy.InputProps<Cloudflare.Hyperdrive.DevOrigin> = {
    scheme: "postgres",
    host: "127.0.0.1",
    port: container.ports["5432/tcp"],
    database: "janitor",
    user: "janitor",
    password: LocalDatabasePassword,
    sslmode: "disable",
  }

  yield* seedDevelopmentData(container.ports["5432/tcp"])

  return {
    databaseId: container.id,
    origin,
  }
})

/**
 * Wipes the local database and refills it with recognisable data.
 *
 * Declared only here, inside the local branch, so it cannot reach Neon: the
 * resource does not exist in a deploy at all. The seed script re-checks that
 * its target is loopback before it truncates anything, so a stray
 * `DATABASE_URL` in the environment cannot redirect it either.
 *
 * The connection string is built from the container rather than read from
 * `.env` because the host port is assigned at random (`external: 0`). Passing
 * it through `env` also orders the two: the command cannot run until the
 * container reports healthy.
 *
 * Set `JANITOR_SEED=false` to skip it. Memoization is scoped to the seed
 * itself, so a restart or a hot reload keeps whatever is in the database and
 * only editing the fixtures triggers a fresh wipe. Run `vp run seed` to force
 * one.
 */
const seedDevelopmentData = (port: Output.Output<number>) =>
  Effect.gen(function* () {
    const isEnabled = yield* Config.Boolean("JANITOR_SEED").pipe(Config.withDefault(true))
    if (!isEnabled) return

    yield* Command.Exec("SeedDatabase", {
      command: "node apps/cluster/seed/main.ts",
      env: {
        DATABASE_URL: Output.interpolate`postgres://janitor:janitor@127.0.0.1:${port}/janitor?sslmode=disable`,
      },
      memo: { include: ["apps/cluster/seed/**"] },
      timeout: "2 minutes",
    })
  })

export const NeonDatabase = Effect.gen(function* () {
  const project = yield* Neon.Project("Database", {
    region: "aws-us-east-1",
    pgVersion: 18,
    migrations: "apps/cluster/migrations",
  })

  return {
    databaseId: project.projectId,
    origin: project.origin,
  }
})

export const JanitorDatabase = Effect.gen(function* () {
  const isDev = yield* Alchemy.ALCHEMY_DEV
  return yield* isDev ? LocalDatabase : NeonDatabase
})

export const JanitorHyperdrive = Effect.gen(function* () {
  const isDev = yield* Alchemy.ALCHEMY_DEV
  const database = yield* JanitorDatabase

  return yield* Cloudflare.Hyperdrive.Connection("Hyperdrive", {
    origin: database.origin,
    ...(isDev ? { dev: database.origin } : undefined),
  })
})
