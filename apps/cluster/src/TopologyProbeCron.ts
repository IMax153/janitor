import * as Effect from "effect/Effect"
import * as Singleton from "effect/unstable/cluster/Singleton"
import { TopologyProbeStore } from "./TopologyProbeStore.ts"

export const TopologyProbeCronName = "topology-probe-cron"

export const TopologyProbeCronLayer = Singleton.make(
  TopologyProbeCronName,
  Effect.gen(function* () {
    const store = yield* TopologyProbeStore

    yield* store.commit({
      id: TopologyProbeCronName,
      step: "cron",
    })
  }),
)
