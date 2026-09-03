import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { GitHubLabelDatabaseId, GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import { GitHubEntityKind, GitHubLabelAvailability } from "../GitHub/ReadModel.ts"
import { GitHubRepositoryTrack, SyncFreshness, SyncGeneration } from "../GitHub/Sync.ts"

/**
 * Auto-labeling rulesets (design: "Ruleset", "Concrete evaluator"). A
 * ruleset is an immutable repository revision. Rules carry stable IDs, one
 * entity target, one evaluator, and one or more synchronized label
 * references identified by stable label ID.
 */

export const MAX_RULES_PER_RULESET = 100
export const MAX_PREDICATES_PER_RULE = 20
export const MAX_LABELS_PER_RULE = 10

/** Client-authored stable identifier; survives renames and reorders. */
export const RuleId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/))
  .pipe(Schema.brand("RuleId"))
  .annotate({ identifier: "RuleId" })
export type RuleId = typeof RuleId.Type

export const RuleName = Schema.Trimmed.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
).annotate({ identifier: "RuleName" })

export const RuleTarget = GitHubEntityKind
export type RuleTarget = typeof RuleTarget.Type

const PredicateText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))

/** Closed predicate set. Predicates within one rule combine with AND. */
export const TitleContains = Schema.TaggedStruct("TitleContains", {
  value: PredicateText,
  caseSensitive: Schema.Boolean,
})
export const AuthorIs = Schema.TaggedStruct("AuthorIs", {
  /** Compared case-insensitively, as GitHub logins are. */
  login: PredicateText,
})
export const BaseBranchIs = Schema.TaggedStruct("BaseBranchIs", {
  /** Exact, case-sensitive branch name without `refs/heads/`. */
  ref: PredicateText,
})
export const DraftStateIs = Schema.TaggedStruct("DraftStateIs", { draft: Schema.Boolean })

export const ConcretePredicate = Schema.Union([
  TitleContains,
  AuthorIs,
  BaseBranchIs,
  DraftStateIs,
]).annotate({ identifier: "ConcretePredicate" })
export type ConcretePredicate = typeof ConcretePredicate.Type

/** Which entity kinds each predicate can be evaluated against. */
export const predicateTargets: Record<ConcretePredicate["_tag"], ReadonlyArray<RuleTarget>> = {
  TitleContains: ["issue", "pull_request"],
  AuthorIs: ["issue", "pull_request"],
  BaseBranchIs: ["pull_request"],
  DraftStateIs: ["pull_request"],
}

export const ConcreteEvaluator = Schema.TaggedStruct("Concrete", {
  predicates: Schema.NonEmptyArray(ConcretePredicate).check(
    Schema.isMaxLength(MAX_PREDICATES_PER_RULE),
  ),
})
export type ConcreteEvaluator = typeof ConcreteEvaluator.Type

/** AI evaluators arrive as another union member once the opt-in gates exist. */
export const RuleEvaluator = Schema.Union([ConcreteEvaluator]).annotate({
  identifier: "RuleEvaluator",
})
export type RuleEvaluator = typeof RuleEvaluator.Type

/** What a matching rule does with its labels. */
export const MatchAction = Schema.Literals(["add", "remove"]).annotate({
  identifier: "MatchAction",
})
export type MatchAction = typeof MatchAction.Type

/**
 * What a rule does with its labels when it stops matching an entity it
 * applies to. `remove-if-applied` only undoes labels this system added;
 * `remove` also strips labels a person added by hand.
 */
export const UnmatchAction = Schema.Literals(["keep", "remove-if-applied", "remove"]).annotate({
  identifier: "UnmatchAction",
})
export type UnmatchAction = typeof UnmatchAction.Type

/** How a ruleset settles two rules that disagree about one label. */
export const ConflictPolicy = Schema.Literals([
  "last-rule-wins",
  "first-rule-wins",
  "add-wins",
  "remove-wins",
]).annotate({ identifier: "ConflictPolicy" })
export type ConflictPolicy = typeof ConflictPolicy.Type

export const DEFAULT_MATCH_ACTION: MatchAction = "add"
export const DEFAULT_UNMATCH_ACTION: UnmatchAction = "remove-if-applied"
export const DEFAULT_CONFLICT_POLICY: ConflictPolicy = "last-rule-wins"

const defaulted = <S extends Schema.Top & Schema.WithoutConstructorDefault>(
  schema: S,
  value: S["Encoded"],
) => schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))

/**
 * Every behaviour choice is a per-rule setting so the editor can expose it.
 * Settings added after a revision was saved decode with their defaults.
 */
export const Rule = Schema.Struct({
  id: RuleId,
  name: RuleName,
  enabled: Schema.Boolean,
  target: RuleTarget,
  evaluator: RuleEvaluator,
  labels: Schema.NonEmptyArray(GitHubLabelDatabaseId).check(
    Schema.isUnique(),
    Schema.isMaxLength(MAX_LABELS_PER_RULE),
  ),
  onMatch: defaulted(MatchAction, DEFAULT_MATCH_ACTION),
  onUnmatch: defaulted(UnmatchAction, DEFAULT_UNMATCH_ACTION),
  /** Evaluated and planned, but never applied to GitHub. */
  dryRun: defaulted(Schema.Boolean, false),
}).annotate({ identifier: "Rule" })
export type Rule = typeof Rule.Type

export const Ruleset = Schema.Struct({
  rules: Schema.Array(Rule).check(Schema.isMaxLength(MAX_RULES_PER_RULESET)),
  conflicts: defaulted(ConflictPolicy, DEFAULT_CONFLICT_POLICY),
}).annotate({ identifier: "Ruleset" })
export type Ruleset = typeof Ruleset.Type

export const emptyRuleset: Ruleset = { rules: [], conflicts: DEFAULT_CONFLICT_POLICY }

/** Monotonic per repository. Zero means nothing has been saved yet. */
export const RulesetRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  .pipe(Schema.brand("RulesetRevision"))
  .annotate({ identifier: "RulesetRevision" })
export type RulesetRevision = typeof RulesetRevision.Type

export const RulesetIssueCode = Schema.Literals([
  "duplicate-rule-id",
  "unresolved-label",
  "unavailable-label",
  "incompatible-predicate",
]).annotate({ identifier: "RulesetIssueCode" })
export type RulesetIssueCode = typeof RulesetIssueCode.Type

export const RulesetIssue = Schema.Struct({
  ruleId: RuleId,
  code: RulesetIssueCode,
  message: Schema.String,
}).annotate({ identifier: "RulesetIssue" })
export type RulesetIssue = typeof RulesetIssue.Type

/** Audit identity from Cloudflare Access: issuer plus subject, never email. */
export const RulesetAuthor = Schema.Struct({
  issuer: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
}).annotate({ identifier: "RulesetAuthor" })
export type RulesetAuthor = typeof RulesetAuthor.Type

/** A label as synchronization currently knows it. */
export const SynchronizedLabel = Schema.Struct({
  labelId: GitHubLabelDatabaseId,
  name: Schema.String,
  availability: GitHubLabelAvailability,
}).annotate({ identifier: "SynchronizedLabel" })
export type SynchronizedLabel = typeof SynchronizedLabel.Type

/**
 * The track generations a revision asked synchronization to verify before
 * it may become active (design: "Rules changes and repair").
 */
export const RulesetPreparation = Schema.Record(Schema.String, SyncGeneration).annotate({
  identifier: "RulesetPreparation",
})
export type RulesetPreparation = typeof RulesetPreparation.Type

/**
 * Which tracks a ruleset needs qualified. Labels back every reference; the
 * entities track carries issue and pull request summaries and labels; the
 * pull request track carries base branch and draft state.
 */
export const requiredTracks = (ruleset: Ruleset): ReadonlyArray<GitHubRepositoryTrack> => {
  const enabled = ruleset.rules.filter((rule) => rule.enabled)
  if (enabled.length === 0) return []
  const tracks: Array<GitHubRepositoryTrack> = ["labels", "entities"]
  if (enabled.some((rule) => rule.target === "pull_request")) tracks.push("pull_requests")
  return tracks
}

/** What the rule editor loads. */
export const RulesetView = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  configuredRevision: RulesetRevision,
  configured: Ruleset,
  /** Null until synchronization has prepared a revision for evaluation. */
  activeRevision: Schema.NullOr(RulesetRevision),
  /** Tracks the configured revision is still waiting on. Empty once active. */
  pendingTracks: Schema.Array(GitHubRepositoryTrack),
  labels: Schema.Array(SynchronizedLabel),
  labelFreshness: SyncFreshness,
}).annotate({ identifier: "RulesetView" })
export type RulesetView = typeof RulesetView.Type

/** Saving replaces the whole ruleset and must name the revision it edited. */
export const SaveRulesetRequest = Schema.Struct({
  expectedRevision: RulesetRevision,
  ruleset: Ruleset,
}).annotate({ identifier: "SaveRulesetRequest" })
export type SaveRulesetRequest = typeof SaveRulesetRequest.Type

/**
 * Semantic validation beyond the schema: stable IDs are unique, every label
 * reference resolves to a synchronized label of this repository that is not
 * known to be gone, and every predicate applies to the rule's target.
 */
export const validateRuleset = (
  ruleset: Ruleset,
  labels: ReadonlyArray<SynchronizedLabel>,
): ReadonlyArray<RulesetIssue> => {
  const issues: Array<RulesetIssue> = []
  const known = new Map(labels.map((label) => [label.labelId, label]))
  const seen = new Set<RuleId>()
  for (const rule of ruleset.rules) {
    if (seen.has(rule.id)) {
      issues.push({
        ruleId: rule.id,
        code: "duplicate-rule-id",
        message: `Rule id '${rule.id}' is used more than once`,
      })
    }
    seen.add(rule.id)
    for (const labelId of rule.labels) {
      const label = known.get(labelId)
      if (label === undefined) {
        issues.push({
          ruleId: rule.id,
          code: "unresolved-label",
          message: `Label ${labelId} is not a synchronized label of this repository`,
        })
      } else if (label.availability === "unavailable") {
        issues.push({
          ruleId: rule.id,
          code: "unavailable-label",
          message: `Label ${labelId} was deleted on GitHub`,
        })
      }
    }
    for (const predicate of rule.evaluator.predicates) {
      if (!predicateTargets[predicate._tag].includes(rule.target)) {
        issues.push({
          ruleId: rule.id,
          code: "incompatible-predicate",
          message: `Predicate ${predicate._tag} does not apply to ${rule.target} rules`,
        })
      }
    }
  }
  return issues
}
