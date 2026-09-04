import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { Story } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import { describePlan, describeRevision } from "@/components/labeling-wire"
import * as Repositories from "@/components/repositories"

const at = DateTime.makeUnsafe("2026-09-03T14:00:00.000Z")
const one: Repositories.RepositoryOverview = {
  repositoryId: "701",
  owner: "effect",
  repo: "one",
  enabled: true,
  ruleCount: 12,
  policyCount: 8,
  access: "accessible",
  configuredRevision: 1,
  activeRevision: 1,
}
const two: Repositories.RepositoryOverview = { ...one, repositoryId: "702", repo: "two" }

const configuration: Repositories.ConfigurationView = {
  repositoryId: "701",
  configuredRevision: 1,
  activeRevision: 1,
  pendingTracks: [],
  policies: [
    {
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
    },
  ],
  rules: [
    {
      id: "r1",
      repositoryId: "701",
      labelId: "11",
      policyId: "p1",
      onNoMatch: "ensure-absent",
      group: null,
      priority: 0,
      enabled: true,
      labelStatus: "valid",
      version: 1,
      createdAt: at,
      updatedAt: at,
    },
  ],
  labels: [{ labelId: "11", name: "bug", availability: "available" }],
  labelFreshness: "verified",
}

const detail: Repositories.RepositoryDetail = {
  configuration,
  reconciliations: [
    {
      repositoryId: "701",
      number: 5,
      snapshotGeneration: "3",
      rulesRevision: 1,
      coveredSequence: "8",
      fingerprint: "a".repeat(64),
      createdAt: at,
      outcome: "evaluated",
      detail: "1 change planned",
      plan: {
        rules: [{ ruleId: "r1", outcome: "match", selected: true }],
        actions: [{ labelId: "11", action: "add", ruleId: "r1" }],
      },
      actions: [{ labelId: "11", action: "add", ruleId: "r1", status: "applied", detail: null }],
      completedAt: at,
    },
  ],
}

const consent: Repositories.AiConsent = {
  repositoryId: "701",
  state: "disabled",
  provider: "openai",
  model: "gpt-5.6-luna",
  activeLeases: 0,
  updatedAt: at,
}

const opened = (): Repositories.Model => ({
  ...Repositories.init().model,
  selected: Option.some("701"),
  detail: Option.some(detail),
})

describe("Repositories", () => {
  it("fetches the list and the catalog on init and opens the first repository", () => {
    const { model, commands } = Repositories.init()
    expect(commands?.map((command) => command.name)).toEqual(["FetchRepositories", "FetchCatalog"])
    Story.story(
      Repositories.update,
      Story.given(model),
      Story.message(Repositories.Message.GotRepositories({ repositories: [one, two] })),
      Story.model((next) => expect(next.selected).toEqual(Option.some("701"))),
      Story.Command.resolve(
        Repositories.FetchDetail({ repositoryId: "701" }),
        Repositories.Message.GotDetail({ repositoryId: "701", detail }),
      ),
      Story.Command.resolve(
        Repositories.FetchConsent({ repositoryId: "701" }),
        Repositories.Message.GotConsent({ repositoryId: "701", consent }),
      ),
      Story.model((next) => {
        expect(next.detail).toEqual(Option.some(detail))
        expect(next.maybeConsent).toEqual(Option.some(consent))
        const repositories = Option.getOrThrow(next.repositories)
        expect(repositories[0]?.ruleCount).toBe(configuration.rules.length)
        expect(repositories[0]?.policyCount).toBe(configuration.policies.length)
        expect(repositories[1]).toEqual(two)
      }),
    )
  })

  it("drops a late answer for a repository that is no longer selected and closes the panel", () => {
    Story.story(
      Repositories.update,
      Story.given({ ...opened(), panel: { _tag: "LoadingPolicy", policyId: "p1" } }),
      Story.message(Repositories.Message.Selected({ repositoryId: "702" })),
      Story.model((next) => {
        expect(next.selected).toEqual(Option.some("702"))
        expect(next.detail).toEqual(Option.none())
        expect(next.panel._tag).toBe("Closed")
      }),
      Story.Command.resolve(
        Repositories.FetchDetail({ repositoryId: "702" }),
        Repositories.Message.GotDetail({ repositoryId: "701", detail }),
      ),
      Story.Command.resolve(
        Repositories.FetchConsent({ repositoryId: "702" }),
        Repositories.Message.GotConsent({ repositoryId: "701", consent }),
      ),
      Story.model((next) => {
        expect(next.detail).toEqual(Option.none())
        expect(next.maybeConsent).toEqual(Option.none())
      }),
    )
  })

  it("opens editors and the bench from the tables", () => {
    Story.story(
      Repositories.update,
      Story.given(opened()),
      Story.message(Repositories.Message.ClickedNewRule()),
      Story.model((next) => expect(next.panel._tag).toBe("RuleEditor")),
      Story.message(Repositories.Message.ClickedNewPolicy()),
      Story.model((next) => {
        expect(next.panel._tag).toBe("PolicyEditor")
        if (next.panel._tag === "PolicyEditor") {
          expect(next.panel.editor.source.policyNames).toEqual(["Base is main"])
        }
      }),
    )
  })

  it("deletes only on the second press and refreshes afterwards", () => {
    Story.story(
      Repositories.update,
      Story.given(opened()),
      Story.message(Repositories.Message.ClickedDeleteRule({ ruleId: "r1", version: 1 })),
      Story.model((next) =>
        expect(next.maybeConfirmingDelete).toEqual(Option.some({ _tag: "Rule", ruleId: "r1" })),
      ),
      Story.Command.expectNone(),
      Story.message(Repositories.Message.ClickedDeleteRule({ ruleId: "r1", version: 1 })),
      Story.Command.resolve(
        Repositories.DeleteSubject({
          url: "/api/v1/repositories/701/rules/r1",
          version: 1,
          what: "rule",
        }),
        Repositories.Message.CompletedDelete({ what: "rule" }),
      ),
      Story.expectOutMessage(
        Repositories.OutMessage.Notified({
          title: "Deleted the rule",
          description: "The configuration revision advanced.",
        }),
      ),
      Story.Command.resolve(
        Repositories.FetchDetail({ repositoryId: "701" }),
        Repositories.Message.GotDetail({ repositoryId: "701", detail }),
      ),
      Story.Command.resolve(
        Repositories.FetchConsent({ repositoryId: "701" }),
        Repositories.Message.GotConsent({ repositoryId: "701", consent }),
      ),
    )
  })

  it("describes revisions and plans for people", () => {
    expect(describeRevision(configuration)).toBe("Revision 1 active")
    expect(
      describeRevision({ ...configuration, activeRevision: null, pendingTracks: ["labels"] }),
    ).toBe("Revision 1 waiting on labels")
    expect(describeRevision({ ...configuration, configuredRevision: 0 })).toBe("Nothing configured")
    expect(describePlan(detail.reconciliations[0]!.plan!, configuration)).toEqual([
      "add bug (Base is main)",
    ])
    expect(
      describePlan(
        detail.reconciliations[0]!.plan!,
        configuration,
        detail.reconciliations[0]!.actions,
      ),
    ).toEqual(["add bug (Base is main) ✓"])
  })
})
