import * as Schema from "effect/Schema"
import { GitHubLabelDatabaseId } from "../GitHub/Id.ts"
import { GitHubEntityKind, GitHubEntityState } from "../GitHub/ReadModel.ts"
import {
  type ConcretePredicate,
  type ConflictPolicy,
  type Rule,
  RuleId,
  RuleName,
  Ruleset,
  RulesetIssue,
} from "./Ruleset.ts"

/**
 * Pure evaluation of a ruleset against one entity snapshot (design:
 * "Concrete evaluator"). The result is a plan: the label changes the
 * ruleset asks for, each traced to the rule that decided it. Nothing here
 * touches GitHub; applying a plan is a separate, later concern.
 */

/** The fields concrete predicates read. The handoff fingerprints the same set. */
export const EntitySnapshot = Schema.Struct({
  kind: GitHubEntityKind,
  title: Schema.String,
  authorLogin: Schema.String,
  state: GitHubEntityState,
  /** Null for issues. */
  baseRef: Schema.NullOr(Schema.String),
  draft: Schema.NullOr(Schema.Boolean),
  labels: Schema.Array(GitHubLabelDatabaseId),
}).annotate({ identifier: "EntitySnapshot" })
export type EntitySnapshot = typeof EntitySnapshot.Type

export const PlanActionKind = Schema.Literals(["add", "remove"]).annotate({
  identifier: "PlanActionKind",
})
export type PlanActionKind = typeof PlanActionKind.Type

/** One label change, traced to the rule that decided it. */
export const PlanAction = Schema.Struct({
  labelId: GitHubLabelDatabaseId,
  action: PlanActionKind,
  ruleId: RuleId,
  ruleName: RuleName,
  /** The rule is configured never to apply, so this line is advisory. */
  dryRun: Schema.Boolean,
}).annotate({ identifier: "PlanAction" })
export type PlanAction = typeof PlanAction.Type

/** A label two rules disagreed about, and which rule the policy chose. */
export const PlanConflict = Schema.Struct({
  labelId: GitHubLabelDatabaseId,
  contenders: Schema.Array(RuleId),
  winner: RuleId,
}).annotate({ identifier: "PlanConflict" })
export type PlanConflict = typeof PlanConflict.Type

export const Plan = Schema.Struct({
  /** Effective changes against the snapshot's current labels, in label order. */
  actions: Schema.Array(PlanAction),
  matched: Schema.Array(RuleId),
  conflicts: Schema.Array(PlanConflict),
}).annotate({ identifier: "Plan" })
export type Plan = typeof Plan.Type

export const emptyPlan: Plan = { actions: [], matched: [], conflicts: [] }

export const evaluatePredicate = (
  predicate: ConcretePredicate,
  snapshot: EntitySnapshot,
): boolean => {
  switch (predicate._tag) {
    case "TitleContains":
      return predicate.caseSensitive
        ? snapshot.title.includes(predicate.value)
        : snapshot.title.toLowerCase().includes(predicate.value.toLowerCase())
    case "AuthorIs":
      return snapshot.authorLogin.toLowerCase() === predicate.login.toLowerCase()
    case "BaseBranchIs":
      return snapshot.baseRef === predicate.ref
    case "DraftStateIs":
      return snapshot.draft === predicate.draft
  }
}

/** A rule applies when enabled and aimed at the snapshot's kind; it matches when every predicate holds. */
export const ruleMatches = (rule: Rule, snapshot: EntitySnapshot): boolean =>
  rule.evaluator.predicates.every((predicate) => evaluatePredicate(predicate, snapshot))

interface Want {
  readonly rule: Rule
  readonly action: PlanActionKind
}

const chooseWinner = (policy: ConflictPolicy, wants: ReadonlyArray<Want>): Want => {
  switch (policy) {
    case "first-rule-wins":
      return wants[0]!
    case "last-rule-wins":
      return wants[wants.length - 1]!
    case "add-wins":
      return wants.find((want) => want.action === "add") ?? wants[wants.length - 1]!
    case "remove-wins":
      return wants.find((want) => want.action === "remove") ?? wants[wants.length - 1]!
  }
}

export interface EvaluationInput {
  readonly ruleset: Ruleset
  readonly snapshot: EntitySnapshot
  /** Labels this system applied earlier and still owns. Drives `remove-if-applied`. */
  readonly applied: ReadonlySet<GitHubLabelDatabaseId>
}

/**
 * Evaluates every enabled rule for the snapshot's kind. A matching rule
 * wants its `onMatch` action for each of its labels; a non-matching rule
 * wants what its `onUnmatch` setting says. Per label, the ruleset's conflict
 * policy picks one want. The plan then lists only the wants that change the
 * snapshot: adds for labels not present, removes for labels present.
 */
export const evaluate = ({ ruleset, snapshot, applied }: EvaluationInput): Plan => {
  const wants = new Map<GitHubLabelDatabaseId, Array<Want>>()
  const matched: Array<RuleId> = []
  const want = (labelId: GitHubLabelDatabaseId, entry: Want) => {
    const existing = wants.get(labelId)
    if (existing === undefined) wants.set(labelId, [entry])
    else existing.push(entry)
  }

  for (const rule of ruleset.rules) {
    if (!rule.enabled || rule.target !== snapshot.kind) continue
    if (ruleMatches(rule, snapshot)) {
      matched.push(rule.id)
      for (const labelId of rule.labels) want(labelId, { rule, action: rule.onMatch })
      continue
    }
    if (rule.onUnmatch === "keep") continue
    for (const labelId of rule.labels) {
      if (rule.onUnmatch === "remove" || applied.has(labelId)) {
        want(labelId, { rule, action: "remove" })
      }
    }
  }

  const present = new Set(snapshot.labels)
  const actions: Array<PlanAction> = []
  const conflicts: Array<PlanConflict> = []
  for (const [labelId, candidates] of wants) {
    const winner = chooseWinner(ruleset.conflicts, candidates)
    if (candidates.some((candidate) => candidate.action !== winner.action)) {
      conflicts.push({
        labelId,
        contenders: candidates.map((candidate) => candidate.rule.id),
        winner: winner.rule.id,
      })
    }
    const changes = winner.action === "add" ? !present.has(labelId) : present.has(labelId)
    if (!changes) continue
    actions.push({
      labelId,
      action: winner.action,
      ruleId: winner.rule.id,
      ruleName: winner.rule.name,
      dryRun: winner.rule.dryRun,
    })
  }
  actions.sort((left, right) => left.labelId.localeCompare(right.labelId))
  return { actions, matched, conflicts }
}

/** A draft ruleset the editor wants evaluated without saving it. */
export const PreviewRulesetRequest = Schema.Struct({ ruleset: Ruleset }).annotate({
  identifier: "PreviewRulesetRequest",
})
export type PreviewRulesetRequest = typeof PreviewRulesetRequest.Type

/** One open entity and what the draft would do to it. */
export const PreviewEntity = Schema.Struct({
  number: Schema.Int,
  snapshot: EntitySnapshot,
  plan: Plan,
}).annotate({ identifier: "PreviewEntity" })
export type PreviewEntity = typeof PreviewEntity.Type

/**
 * The editor's test bench: semantic issues the save would reject, and the
 * plan for each of the most recently updated open entities. Ownership is
 * unknown for a draft, so `remove-if-applied` never removes here.
 */
export const RulesetPreview = Schema.Struct({
  issues: Schema.Array(RulesetIssue),
  entities: Schema.Array(PreviewEntity),
}).annotate({ identifier: "RulesetPreview" })
export type RulesetPreview = typeof RulesetPreview.Type
