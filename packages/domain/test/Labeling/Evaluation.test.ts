import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { GitHubLabelDatabaseId } from "@janitor/domain/GitHub/Id"
import {
  type EntitySnapshot,
  evaluate,
  evaluatePredicate,
} from "@janitor/domain/Labeling/Evaluation"
import { type Rule, RuleId, Ruleset } from "@janitor/domain/Labeling/Ruleset"

const bug = GitHubLabelDatabaseId.make("1")
const triage = GitHubLabelDatabaseId.make("2")

const snapshot = (overrides: Partial<EntitySnapshot> = {}): EntitySnapshot => ({
  kind: "pull_request",
  title: "Fix Cleanup",
  authorLogin: "Octocat",
  state: "open",
  baseRef: "main",
  draft: false,
  labels: [],
  ...overrides,
})

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

const run = (rules: ReadonlyArray<Rule>, input: EntitySnapshot, applied: Array<string> = []) =>
  evaluate({
    ruleset: { rules, conflicts: "last-rule-wins" },
    snapshot: input,
    applied: new Set(applied.map((id) => GitHubLabelDatabaseId.make(id))),
  })

describe("Evaluation", () => {
  it("evaluates each predicate against the snapshot", () => {
    const pr = snapshot()
    assert.isTrue(
      evaluatePredicate({ _tag: "TitleContains", value: "cleanup", caseSensitive: false }, pr),
    )
    assert.isFalse(
      evaluatePredicate({ _tag: "TitleContains", value: "cleanup", caseSensitive: true }, pr),
    )
    assert.isTrue(evaluatePredicate({ _tag: "AuthorIs", login: "OCTOCAT" }, pr))
    assert.isFalse(evaluatePredicate({ _tag: "BaseBranchIs", ref: "Main" }, pr))
    assert.isTrue(evaluatePredicate({ _tag: "DraftStateIs", draft: false }, pr))
    assert.isFalse(
      evaluatePredicate(
        { _tag: "BaseBranchIs", ref: "main" },
        snapshot({ kind: "issue", baseRef: null }),
      ),
    )
  })

  it("plans an add for a matching rule and nothing when the label is present", () => {
    const plan = run([rule()], snapshot())
    assert.deepStrictEqual(plan, {
      actions: [
        {
          labelId: bug,
          action: "add",
          ruleId: RuleId.make("base-main"),
          ruleName: "Base is main",
          dryRun: false,
        },
      ],
      matched: [RuleId.make("base-main")],
      conflicts: [],
    })
    assert.deepStrictEqual(run([rule()], snapshot({ labels: [bug] })).actions, [])
  })

  it("skips disabled rules and rules aimed at another kind", () => {
    assert.deepStrictEqual(run([rule({ enabled: false })], snapshot()).matched, [])
    const issueOnly = rule({
      target: "issue",
      evaluator: { _tag: "Concrete", predicates: [{ _tag: "AuthorIs", login: "octocat" }] },
    })
    assert.deepStrictEqual(run([issueOnly], snapshot()).matched, [])
    assert.deepStrictEqual(
      run([issueOnly], snapshot({ kind: "issue", baseRef: null, draft: null })).matched,
      [RuleId.make("base-main")],
    )
  })

  it("honours the unmatch setting", () => {
    const off = snapshot({ baseRef: "develop", labels: [bug] })
    assert.deepStrictEqual(run([rule({ onUnmatch: "keep" })], off).actions, [])
    assert.deepStrictEqual(run([rule({ onUnmatch: "remove-if-applied" })], off).actions, [])
    assert.strictEqual(
      run([rule({ onUnmatch: "remove-if-applied" })], off, [bug]).actions[0]?.action,
      "remove",
    )
    assert.strictEqual(run([rule({ onUnmatch: "remove" })], off).actions[0]?.action, "remove")
    // Removing a label that is not there is not a change.
    assert.deepStrictEqual(
      run([rule({ onUnmatch: "remove" })], snapshot({ baseRef: "develop" })).actions,
      [],
    )
  })

  it("lets a matching rule remove labels and carries the dry-run flag", () => {
    const plan = run(
      [rule({ id: RuleId.make("untriage"), labels: [triage], onMatch: "remove", dryRun: true })],
      snapshot({ labels: [triage] }),
    )
    assert.deepStrictEqual(plan.actions, [
      {
        labelId: triage,
        action: "remove",
        ruleId: RuleId.make("untriage"),
        ruleName: "Base is main",
        dryRun: true,
      },
    ])
  })

  it("resolves conflicts by the ruleset policy and records them", () => {
    const adds = rule({ id: RuleId.make("adds") })
    const removes = rule({ id: RuleId.make("removes"), onMatch: "remove" })
    const withPolicy = (conflicts: Ruleset["conflicts"], rules: ReadonlyArray<Rule>) =>
      evaluate({ ruleset: { rules, conflicts }, snapshot: snapshot(), applied: new Set() })
    assert.strictEqual(withPolicy("last-rule-wins", [adds, removes]).actions.length, 0)
    assert.strictEqual(withPolicy("first-rule-wins", [adds, removes]).actions[0]?.ruleId, "adds")
    assert.strictEqual(withPolicy("add-wins", [removes, adds]).actions[0]?.ruleId, "adds")
    assert.strictEqual(withPolicy("remove-wins", [adds, removes]).actions.length, 0)
    assert.deepStrictEqual(withPolicy("last-rule-wins", [adds, removes]).conflicts, [
      {
        labelId: bug,
        contenders: [RuleId.make("adds"), RuleId.make("removes")],
        winner: RuleId.make("removes"),
      },
    ])
    // Agreement is not a conflict.
    assert.deepStrictEqual(
      withPolicy("last-rule-wins", [adds, rule({ id: RuleId.make("also") })]).conflicts,
      [],
    )
  })

  it.effect("decodes a ruleset saved before the settings existed with defaults", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(Ruleset)({
        rules: [
          {
            id: "base-main",
            name: "Base is main",
            enabled: true,
            target: "pull_request",
            evaluator: { _tag: "Concrete", predicates: [{ _tag: "BaseBranchIs", ref: "main" }] },
            labels: ["1"],
          },
        ],
      })
      assert.strictEqual(decoded.conflicts, "last-rule-wins")
      assert.deepStrictEqual(
        [decoded.rules[0]?.onMatch, decoded.rules[0]?.onUnmatch, decoded.rules[0]?.dryRun],
        ["add", "remove-if-applied", false],
      )
    }),
  )
})
