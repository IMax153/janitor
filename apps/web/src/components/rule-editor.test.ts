import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { Story } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import type { PolicyRecord, RuleRecord } from "./labeling-wire"
import * as RuleEditor from "./rule-editor"

const at = DateTime.makeUnsafe("2026-09-03T14:00:00.000Z")
const published: PolicyRecord = {
  policyId: "p1",
  repositoryId: "701",
  name: "Base is main",
  target: "pull_request",
  description: "",
  publishedVersionId: "v1",
  publishedRevision: 1,
  version: 2,
  createdAt: at,
  updatedAt: at,
}
const draft: PolicyRecord = {
  ...published,
  policyId: "p2",
  name: "Draft",
  publishedVersionId: null,
  publishedRevision: null,
}
const labels = [{ labelId: "11", name: "bug", availability: "available" as const }]
const rule: RuleRecord = {
  id: "r1",
  repositoryId: "701",
  labelId: "11",
  policyId: "p1",
  onNoMatch: "preserve",
  group: "size",
  priority: 3,
  enabled: true,
  labelStatus: "valid",
  version: 1,
  createdAt: at,
  updatedAt: at,
}

describe("RuleEditor", () => {
  it("needs a label and a published policy, then saves the binding", () => {
    const model = RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published, draft],
      existing: Option.none(),
    })
    expect(RuleEditor.draftIssues(model)).toEqual(["Pick a label", "Pick a published policy"])
    Story.story(
      RuleEditor.update,
      Story.given(model),
      Story.message(RuleEditor.Message.SelectedLabel({ labelId: "11" })),
      Story.message(RuleEditor.Message.UpdatedPolicy({ value: "p1" })),
      Story.message(RuleEditor.Message.UpdatedGroup({ value: "size" })),
      Story.message(RuleEditor.Message.UpdatedPriority({ value: "abc" })),
      Story.model((next) =>
        expect(RuleEditor.draftIssues(next)).toEqual(["Priority must be a whole number"]),
      ),
      Story.message(RuleEditor.Message.UpdatedPriority({ value: "3" })),
      Story.message(RuleEditor.Message.ClickedSave()),
      Story.Command.resolve(
        RuleEditor.SaveRule({
          repositoryId: "701",
          identity: { _tag: "New" },
          labelId: "11",
          policyId: "p1",
          onNoMatch: "ensure-absent",
          group: "size",
          priority: 3,
          enabled: true,
        }),
        RuleEditor.Message.SucceededSaveRule({ rule }),
      ),
      Story.expectOutMessage(RuleEditor.OutMessage.Saved({ rule })),
    )
  })

  it("loads an existing rule and surfaces server issues", () => {
    const model = RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published],
      existing: Option.some(rule),
    })
    expect(model.identity).toEqual({ _tag: "Existing", ruleId: "r1", version: 1 })
    expect(model.group).toBe("size")
    expect(model.priority).toBe("3")
    Story.story(
      RuleEditor.update,
      Story.given(model),
      Story.message(
        RuleEditor.Message.RejectedSaveRule({
          issues: [{ code: "unavailable-label", message: "Label bug was deleted on GitHub" }],
        }),
      ),
      Story.model((next) => expect(next.submission._tag).toBe("Rejected")),
      Story.expectNoOutMessage(),
    )
  })
})
