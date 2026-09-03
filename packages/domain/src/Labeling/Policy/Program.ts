import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"
import { GitHubEntityKind } from "../../GitHub/ReadModel.ts"
import {
  Condition,
  conditionFromSource,
  ConditionSource,
  conditionToSource,
  PolicyId,
  type PolicyNames,
  UnknownPolicyName,
} from "./Condition.ts"

export { UnknownPolicyName } from "./Condition.ts"

/**
 * Policy programs (plan: "Policies"). A program is applicability plus an
 * evaluator. Applicability is scope: a program that does not apply says
 * `not-applicable`, which is neither a match nor a miss. The evaluator is
 * a condition today; a classifier is a later variant of the same union.
 */

export const PolicyTarget = GitHubEntityKind
export type PolicyTarget = typeof PolicyTarget.Type

export const ConditionsEvaluator = Schema.TaggedStruct("Conditions", { matchesWhen: Condition })
export const Evaluator = Schema.Union([ConditionsEvaluator]).annotate({ identifier: "Evaluator" })
export type Evaluator = typeof Evaluator.Type

export const Program = Schema.Struct({
  target: PolicyTarget,
  appliesWhen: Schema.NullOr(Condition).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  evaluator: Evaluator,
}).annotate({ identifier: "Program" })
export type Program = typeof Program.Type
type ProgramEncoded = typeof Program.Encoded

/** What people write. The evaluator is implied by which key is present. */
export const ProgramSource = Schema.Struct({
  target: PolicyTarget,
  appliesWhen: Schema.optionalKey(ConditionSource),
  matchesWhen: ConditionSource,
}).annotate({ identifier: "ProgramSource" })
export type ProgramSource = typeof ProgramSource.Type

export const programFromSource = (
  source: ProgramSource,
  names: PolicyNames,
): Program | UnknownPolicyName => {
  const appliesWhen =
    source.appliesWhen === undefined ? null : conditionFromSource(source.appliesWhen, names)
  if (appliesWhen instanceof UnknownPolicyName) return appliesWhen
  const matchesWhen = conditionFromSource(source.matchesWhen, names)
  if (matchesWhen instanceof UnknownPolicyName) return matchesWhen
  return { target: source.target, appliesWhen, evaluator: { _tag: "Conditions", matchesWhen } }
}

export const programToSource = (program: Program, names: PolicyNames): ProgramSource => ({
  target: program.target,
  ...(program.appliesWhen === null
    ? {}
    : { appliesWhen: conditionToSource(program.appliesWhen, names) }),
  matchesWhen: conditionToSource(program.evaluator.matchesWhen, names),
})

/** Decodes authored JSON into a program for one repository's policy names, and encodes back. */
export const ProgramFromSource = (names: PolicyNames) =>
  ProgramSource.pipe(
    Schema.decodeTo(Program, {
      decode: SchemaGetter.transformOrFail(
        (source: ProgramSource): Effect.Effect<ProgramEncoded, SchemaIssue.Issue> => {
          const program = programFromSource(source, names)
          return program instanceof UnknownPolicyName
            ? Effect.fail(
                new SchemaIssue.InvalidValue({
                  message: `Policy '${program.name}' does not exist in this repository`,
                }),
              )
            : Effect.succeed(program as unknown as ProgramEncoded)
        },
      ),
      // A stored program's encoded form is its runtime form; the cast only widens optional keys.
      encode: SchemaGetter.transform((program: ProgramEncoded) =>
        programToSource(program as unknown as Program, names),
      ),
    }),
  )

// OUTCOMES

/**
 * Three-valued logic plus scope. `unknown` means a fact the snapshot
 * cannot supply was needed; `not-applicable` means `appliesWhen` said no.
 * Only `no-match` may remove a label.
 */
export const Outcome = Schema.Literals(["match", "no-match", "unknown", "not-applicable"]).annotate(
  { identifier: "Outcome" },
)
export type Outcome = typeof Outcome.Type

/** A condition's outcome, before applicability is considered. */
export type Truth = "match" | "no-match" | "unknown"

export const NodeRoot = Schema.Literals(["appliesWhen", "matchesWhen"])
export type NodeRoot = typeof NodeRoot.Type

export const NodeSegment = Schema.Union([
  Schema.TaggedStruct("Child", { index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.TaggedStruct("Not", {}),
  Schema.TaggedStruct("Policy", { policyId: PolicyId, root: NodeRoot }),
])
export type NodeSegment = typeof NodeSegment.Type

export const NodeLocation = Schema.Struct({
  root: NodeRoot,
  path: Schema.Array(NodeSegment),
}).annotate({ identifier: "NodeLocation" })
export type NodeLocation = typeof NodeLocation.Type

export const formatNodeLocation = (location: NodeLocation): string =>
  [
    location.root,
    ...location.path.map((segment) => {
      switch (segment._tag) {
        case "Child":
          return `#${segment.index + 1}`
        case "Not":
          return "not"
        case "Policy":
          return `policy ${segment.policyId} ${segment.root}`
      }
    }),
  ].join(" > ")

export const NodeTrace = Schema.Struct({
  location: NodeLocation,
  outcome: Schema.Literals(["match", "no-match", "unknown"]),
  reason: Schema.String,
}).annotate({ identifier: "NodeTrace" })
export type NodeTrace = typeof NodeTrace.Type

export const MAX_TRACE = 64

export const Evaluation = Schema.Struct({
  outcome: Outcome,
  reason: Schema.String,
  trace: Schema.Array(NodeTrace).check(Schema.isMaxLength(MAX_TRACE)),
}).annotate({ identifier: "Evaluation" })
export type Evaluation = typeof Evaluation.Type
