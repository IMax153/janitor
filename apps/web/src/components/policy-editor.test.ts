import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { Story } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import type { PolicyDetail } from "./labeling-wire"
import * as PolicyEditor from "./policy-editor"

const at = DateTime.makeUnsafe("2026-09-03T14:00:00.000Z")
const detail: PolicyDetail = {
  policy: {
    policyId: "p1",
    repositoryId: "701",
    name: "Base is main",
    target: "pull_request",
    description: "",
    publishedVersionId: null,
    publishedRevision: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
  },
  draft: {
    target: "pull_request",
    matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
  },
  draftDiffers: true,
  published: null,
}

const fresh = () =>
  PolicyEditor.init({
    repositoryId: "701",
    catalog: [],
    policyNames: ["Ready"],
    existing: Option.none(),
  })

describe("PolicyEditor", () => {
  it("starts from a working program and requires a name before publishing", () => {
    const model = fresh()
    expect(PolicyEditor.draftIssues(model)).toEqual(["Name is required"])
    Story.story(
      PolicyEditor.update,
      Story.given(model),
      Story.message(PolicyEditor.Message.ClickedPublish()),
      Story.Command.expectNone(),
      Story.message(PolicyEditor.Message.UpdatedName({ value: "Base is main" })),
      Story.message(PolicyEditor.Message.ClickedPublish()),
      Story.model((next) => expect(next.submission).toEqual({ _tag: "Submitting", publish: true })),
      Story.Command.resolve(
        PolicyEditor.SavePolicy({
          repositoryId: "701",
          identity: { _tag: "New" },
          name: "Base is main",
          description: "",
          source: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
          },
          publish: true,
        }),
        PolicyEditor.Message.SucceededSavePolicy({ detail, published: true }),
      ),
      Story.expectOutMessage(PolicyEditor.OutMessage.Saved({ detail, published: true })),
      Story.model((next) =>
        expect(next.identity).toEqual({ _tag: "Existing", policyId: "p1", version: 1 }),
      ),
    )
  })

  it("validates the draft and resets validation when the source changes", () => {
    Story.story(
      PolicyEditor.update,
      Story.given({ ...fresh(), name: "x" }),
      Story.message(PolicyEditor.Message.ClickedValidate()),
      Story.model((next) => expect(next.validation._tag).toBe("Validating")),
      Story.Command.resolve(
        PolicyEditor.ValidateDraft({
          repositoryId: "701",
          source: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
          },
        }),
        PolicyEditor.Message.CompletedValidate({
          response: {
            _tag: "Valid",
            manifest: {
              facts: ["baseRef"],
              tracks: ["pull_requests"],
              references: [],
              nodeCount: 1,
              expandedNodeCount: 1,
            },
          },
        }),
      ),
      Story.model((next) => expect(next.validation._tag).toBe("Valid")),
      Story.message(
        PolicyEditor.Message.GotSourceMessage({
          message: { _tag: "EditedSource", source: "{ not json" },
        }),
      ),
      Story.model((next) => {
        expect(next.validation._tag).toBe("NotValidated")
        expect(PolicyEditor.draftIssues(next)[0]).toContain("JSON")
      }),
    )
  })

  it("keeps the draft and moves the version forward on a conflict", () => {
    Story.story(
      PolicyEditor.update,
      Story.given({ ...fresh(), name: "x" }),
      Story.message(
        PolicyEditor.Message.ConflictedSavePolicy({
          detail: { ...detail, policy: { ...detail.policy, version: 4 } },
        }),
      ),
      Story.model((next) => {
        expect(next.identity).toEqual({ _tag: "Existing", policyId: "p1", version: 4 })
        expect(next.submission._tag).toBe("Conflicted")
        expect(next.name).toBe("x")
      }),
      Story.expectNoOutMessage(),
    )
  })
})
