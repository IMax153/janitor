import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { GitHubLabelDatabaseId } from "@janitor/domain/GitHub/Id"
import {
  requiredTracks,
  Rule,
  RuleId,
  Ruleset,
  type SynchronizedLabel,
  validateRuleset,
} from "@janitor/domain/Labeling/Ruleset"

const bug = GitHubLabelDatabaseId.make("1")
const gone = GitHubLabelDatabaseId.make("2")
const labels: ReadonlyArray<SynchronizedLabel> = [
  { labelId: bug, name: "bug", availability: "available" },
  { labelId: gone, name: "old", availability: "unavailable" },
]

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  id: RuleId.make("base-main"),
  name: "Base is main",
  enabled: true,
  target: "pull_request",
  evaluator: { _tag: "Concrete", predicates: [{ _tag: "BaseBranchIs", ref: "main" }] },
  labels: [bug],
  onMatch: "add",
  onUnmatch: "remove-if-applied",
  dryRun: false,
  ...overrides,
})

const decodeRuleset = Schema.decodeUnknownEffect(Ruleset)

describe("Ruleset", () => {
  it.effect("round-trips a ruleset through JSON", () =>
    Effect.gen(function* () {
      const ruleset: Ruleset = { rules: [rule()], conflicts: "last-rule-wins" }
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(Ruleset))(ruleset)
      const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Ruleset))(json)
      assert.deepStrictEqual(decoded, ruleset)
    }),
  )

  it.effect("rejects structurally invalid rules at the schema boundary", () =>
    Effect.gen(function* () {
      const rejects = (input: unknown) =>
        Effect.map(Effect.flip(decodeRuleset(input)), (error) => error._tag)
      assert.strictEqual(
        yield* rejects({ rules: [rule({ id: "Bad Id" as RuleId })] }),
        "SchemaError",
      )
      assert.strictEqual(yield* rejects({ rules: [rule({ name: "   " })] }), "SchemaError")
      assert.strictEqual(yield* rejects({ rules: [rule({ labels: [] as never })] }), "SchemaError")
      assert.strictEqual(yield* rejects({ rules: [rule({ labels: [bug, bug] })] }), "SchemaError")
      assert.strictEqual(
        yield* rejects({
          rules: [rule({ evaluator: { _tag: "Concrete", predicates: [] as never } })],
        }),
        "SchemaError",
      )
    }),
  )

  it("reports duplicate ids, unresolved or deleted labels, and incompatible predicates", () => {
    const issues = validateRuleset(
      {
        conflicts: "last-rule-wins",
        rules: [
          rule(),
          rule({ labels: [GitHubLabelDatabaseId.make("99")] }),
          rule({ id: RuleId.make("deleted"), labels: [gone] }),
          rule({
            id: RuleId.make("issue-draft"),
            target: "issue",
            evaluator: { _tag: "Concrete", predicates: [{ _tag: "DraftStateIs", draft: true }] },
          }),
        ],
      },
      labels,
    )
    assert.deepStrictEqual(
      issues.map((issue) => [issue.ruleId, issue.code]),
      [
        ["base-main", "duplicate-rule-id"],
        ["base-main", "unresolved-label"],
        ["deleted", "unavailable-label"],
        ["issue-draft", "incompatible-predicate"],
      ],
    )
  })

  it("accepts a valid ruleset", () => {
    assert.deepStrictEqual(
      validateRuleset(
        {
          conflicts: "last-rule-wins",
          rules: [
            rule(),
            rule({
              id: RuleId.make("titled"),
              target: "issue",
              evaluator: {
                _tag: "Concrete",
                predicates: [
                  { _tag: "TitleContains", value: "bug", caseSensitive: false },
                  { _tag: "AuthorIs", login: "octocat" },
                ],
              },
            }),
          ],
        },
        labels,
      ),
      [],
    )
  })

  it("derives the tracks a ruleset needs from its enabled rules", () => {
    assert.deepStrictEqual(requiredTracks({ rules: [], conflicts: "last-rule-wins" }), [])
    assert.deepStrictEqual(
      requiredTracks({ rules: [rule({ enabled: false })], conflicts: "last-rule-wins" }),
      [],
    )
    assert.deepStrictEqual(requiredTracks({ rules: [rule()], conflicts: "last-rule-wins" }), [
      "labels",
      "entities",
      "pull_requests",
    ])
    assert.deepStrictEqual(
      requiredTracks({
        conflicts: "last-rule-wins",
        rules: [
          rule({
            target: "issue",
            evaluator: { _tag: "Concrete", predicates: [{ _tag: "AuthorIs", login: "octocat" }] },
          }),
        ],
      }),
      ["labels", "entities"],
    )
  })
})
