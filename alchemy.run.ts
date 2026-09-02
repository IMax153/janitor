import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Docker from "alchemy/Docker"
import * as Neon from "alchemy/Neon"
import * as Provider from "alchemy/Provider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { TopologyProbeDatabase } from "@janitor/cluster/Database"
import ClusterWorker from "@janitor/cluster/Worker"

const DockerProviders = Layer.effect(
  Docker.Providers,
  Provider.collection([Docker.Container, Docker.Image]),
).pipe(
  Layer.provide([Docker.ContainerProvider(), Docker.ImageProvider()]),
  Layer.provideMerge(Docker.DockerLive),
)

const Providers = Layer.mergeAll(Cloudflare.providers(), DockerProviders, Neon.providers())

export default Alchemy.Stack(
  "Janitor",
  {
    providers: Providers,
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const database = yield* TopologyProbeDatabase
    const cluster = yield* ClusterWorker

    const website = yield* Cloudflare.Website.Foldkit("Website", {
      rootDir: "apps/web",
    })

    return {
      databaseId: database.databaseId,
      clusterUrl: cluster.url,
      websiteUrl: website.url,
    }
  }),
)
