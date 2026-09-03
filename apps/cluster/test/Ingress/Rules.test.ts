import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { RulesetView } from "@janitor/domain/Labeling/Ruleset"
import { RulesetRevision } from "@janitor/domain/Labeling/Ruleset"
import { CurrentAccessIdentity } from "../../src/Ingress/Middleware.ts"
import { RulesRoutesLayer } from "../../src/Ingress/Rules.ts"
import {
  LabelingRulesets,
  RepositoryNotFound,
  RulesetConflict,
  RulesetInvalid,
  type SaveRuleset,
} from "../../src/Labeling/Rulesets.ts"

const repositoryId = GitHubRepositoryDatabaseId.make("701")
const view: RulesetView = {
  repositoryId,
  configuredRevision: RulesetRevision.make(1),
  configured: { rules: [] },
  activeRevision: null,
  pendingTracks: [],
  labels: [],
  labelFreshness: "projected",
}
const identity = {
  issuer: "https://team.cloudflareaccess.test",
  subject: "user-1",
  email: undefined,
  expiresAt: DateTime.makeUnsafe("2026-09-03T12:00:00.000Z"),
}

const withHandler = <A, E, R>(
  service: LabelingRulesets["Service"],
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(RulesRoutesLayer, { disableLogger: true })),
    ({ handler }) =>
      use((request) =>
        handler(
          request,
          Context.make(LabelingRulesets, service).pipe(
            Context.add(CurrentAccessIdentity, identity),
          ),
        ),
      ),
    ({ dispose }) => Effect.promise(dispose),
  )

const put = (body: unknown, path = `/repositories/${repositoryId}/rules`) =>
  new Request(`https://janitor.example${path}`, {
    method: "PUT",
    headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const saveBody = { expectedRevision: 1, ruleset: { rules: [] } }

describe("RulesRoutes", () => {
  it.effect("loads the view and 404s an unknown repository", () =>
    withHandler(
      {
        load: (id) =>
          id === repositoryId
            ? Effect.succeed(view)
            : Effect.fail(new RepositoryNotFound({ repositoryId: id })),
        save: () => Effect.die("unused"),
      },
      (handler) =>
        Effect.gen(function* () {
          const ok = yield* Effect.promise(() =>
            handler(new Request(`https://janitor.example/repositories/${repositoryId}/rules`)),
          )
          assert.strictEqual(ok.status, 200)
          const body = yield* Effect.promise(() => ok.json())
          assert.strictEqual(body.configuredRevision, 1)
          const missing = yield* Effect.promise(() =>
            handler(new Request("https://janitor.example/repositories/999/rules")),
          )
          assert.strictEqual(missing.status, 404)
          const malformed = yield* Effect.promise(() =>
            handler(new Request("https://janitor.example/repositories/not-an-id/rules")),
          )
          assert.strictEqual(malformed.status, 400)
        }),
    ),
  )

  it.effect("saves with the Access identity as author", () => {
    const seen: Array<SaveRuleset> = []
    return withHandler(
      {
        load: () => Effect.die("unused"),
        save: (request) =>
          Effect.sync(() => {
            seen.push(request)
            return { ...view, configuredRevision: RulesetRevision.make(2) }
          }),
      },
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() => handler(put(saveBody)))
          assert.strictEqual(response.status, 200)
          assert.strictEqual((yield* Effect.promise(() => response.json())).configuredRevision, 2)
          assert.deepStrictEqual(seen[0]?.author, {
            issuer: "https://team.cloudflareaccess.test",
            subject: "user-1",
          })
          assert.strictEqual(seen[0]?.expectedRevision, 1)
        }),
    )
  })

  it.effect("maps conflict, invalid, malformed body, and cross-origin to their statuses", () =>
    Effect.gen(function* () {
      const conflict = yield* withHandler(
        {
          load: () => Effect.die("unused"),
          save: () => Effect.fail(new RulesetConflict({ current: view })),
        },
        (handler) => Effect.promise(() => handler(put(saveBody))),
      )
      assert.strictEqual(conflict.status, 409)
      assert.strictEqual((yield* Effect.promise(() => conflict.json())).configuredRevision, 1)

      const invalid = yield* withHandler(
        {
          load: () => Effect.die("unused"),
          save: () =>
            Effect.fail(
              new RulesetInvalid({
                issues: [{ ruleId: "r1" as never, code: "unresolved-label", message: "nope" }],
              }),
            ),
        },
        (handler) => Effect.promise(() => handler(put(saveBody))),
      )
      assert.strictEqual(invalid.status, 422)
      assert.deepStrictEqual(
        (yield* Effect.promise(() => invalid.json())).issues[0].code,
        "unresolved-label",
      )

      const malformed = yield* withHandler(
        { load: () => Effect.die("unused"), save: () => Effect.die("must not run") },
        (handler) => Effect.promise(() => handler(put({ expectedRevision: -1 }))),
      )
      assert.strictEqual(malformed.status, 400)

      const crossOrigin = yield* withHandler(
        { load: () => Effect.die("unused"), save: () => Effect.die("must not run") },
        (handler) =>
          Effect.promise(() =>
            handler(
              new Request(`https://janitor.example/repositories/${repositoryId}/rules`, {
                method: "PUT",
                headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" },
                body: JSON.stringify(saveBody),
              }),
            ),
          ),
      )
      assert.strictEqual(crossOrigin.status, 403)
    }),
  )
})
