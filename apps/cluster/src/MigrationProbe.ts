import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

interface MigrationProbeRow extends Record<string, Cloudflare.SqlStorageValue> {
  readonly writes: number
}

export class MigrationProbe extends Cloudflare.DurableObject<MigrationProbe>()(
  "MigrationProbe",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState

    return Effect.gen(function* () {
      void (yield* state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS migration_probe (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          writes INTEGER NOT NULL
        )
      `))

      return {
        verify: Effect.fn("MigrationProbe.verify")(function* () {
          void (yield* state.storage.sql.exec(`
            INSERT INTO migration_probe (id, writes)
            VALUES (1, 1)
            ON CONFLICT (id) DO UPDATE SET writes = writes + 1
          `))

          const cursor = yield* state.storage.sql.exec<MigrationProbeRow>(
            "SELECT writes FROM migration_probe WHERE id = 1",
          )
          const row = yield* cursor.one()

          return {
            writes: row.writes,
            databaseSize: state.storage.sql.databaseSize,
          }
        }),
      }
    })
  }),
) {}
