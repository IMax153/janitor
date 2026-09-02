import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export const TopologyProbeStep = Schema.Literals(["first", "second", "queue", "cron"])
export type TopologyProbeStep = typeof TopologyProbeStep.Type

export class TopologyProbeStoreError extends Schema.TaggedError<TopologyProbeStoreError>()(
  "@janitor/cluster/Probe/TopologyProbeStoreError",
  {
    step: TopologyProbeStep,
    message: Schema.String,
  },
) {}

export interface TopologyProbeCommitInput {
  readonly id: string
  readonly step: TopologyProbeStep
}

export class TopologyProbeStore extends Context.Service<
  TopologyProbeStore,
  {
    readonly commit: (
      input: TopologyProbeCommitInput,
    ) => Effect.Effect<void, TopologyProbeStoreError>
  }
>()("@janitor/cluster/TopologyProbe/TopologyProbeStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const commit = Effect.fn("TopologyProbeStore.commit")(function* ({
      id,
      step,
    }: TopologyProbeCommitInput) {
      yield* sql`
        INSERT INTO workflow_probe_commit ${sql.insert({ probe_id: id, step })}
        ON CONFLICT (probe_id, step) DO NOTHING
      `.pipe(
        Effect.mapError((error) => new TopologyProbeStoreError({ step, message: error.message })),
      )
    })

    return {
      commit,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
