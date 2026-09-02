import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Docker from "alchemy/Docker"
import * as Neon from "alchemy/Neon"
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

  return {
    databaseId: container.id,
    origin,
  }
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
