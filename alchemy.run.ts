import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Docker from "alchemy/Docker"
import * as Neon from "alchemy/Neon"
import * as Provider from "alchemy/Provider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { JanitorDatabase } from "@janitor/cluster/Database"
import ClusterWorker, { DOMAIN } from "@janitor/cluster/Worker"

const WEBSITE_DEV_PORT = 1337

const DockerProviders = Layer.effect(
  Docker.Providers,
  Provider.collection([Docker.Container, Docker.Image]),
).pipe(
  Layer.provide([Docker.ContainerProvider(), Docker.ImageProvider()]),
  Layer.provideMerge(Docker.DockerLive),
)

const Providers = Layer.mergeAll(
  Cloudflare.providers(),
  Command.providers(),
  DockerProviders,
  Neon.providers(),
)

export default Alchemy.Stack(
  "Janitor",
  {
    providers: Providers,
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const database = yield* JanitorDatabase
    const cluster = yield* ClusterWorker

    const website = yield* Cloudflare.Website.Foldkit("Website", {
      rootDir: new URL("./apps/web", import.meta.url).pathname,
      domain: DOMAIN,
      workersDev: false,
      dev: { port: WEBSITE_DEV_PORT, strictPort: true },
    })

    return {
      databaseId: database.databaseId,
      apiUrl: cluster.url,
      url: website.url,
    }
  }),
)
