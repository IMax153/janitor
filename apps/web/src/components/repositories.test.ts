import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { Story } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import * as Repositories from "./repositories"

const one: Repositories.RepositoryOverview = {
  repositoryId: "701",
  owner: "effect",
  repo: "one",
  enabled: true,
  access: "accessible",
  configuredRevision: 1,
  activeRevision: 1,
}
const two: Repositories.RepositoryOverview = { ...one, repositoryId: "702", repo: "two" }

const at = DateTime.makeUnsafe("2026-09-03T14:00:00.000Z")
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
      createdAt: DateTime.makeUnsafe("2026-09-03T14:40:25.000Z"),
      outcome: "evaluated",
      detail: "1 change planned",
      plan: {
        rules: [{ ruleId: "r1", outcome: "match", selected: true }],
        actions: [{ labelId: "11", action: "add", ruleId: "r1" }],
      },
      completedAt: DateTime.makeUnsafe("2026-09-03T14:40:26.000Z"),
    },
  ],
}

describe("Repositories", () => {
  it("fetches the list on init and opens the first repository", () => {
    const { model, commands } = Repositories.init()
    expect(commands?.map((command) => command.name)).toEqual(["FetchRepositories"])
    Story.story(
      Repositories.update,
      Story.given(model),
      Story.message(Repositories.Message.GotRepositories({ repositories: [one, two] })),
      Story.model((next) => expect(next.selected).toEqual(Option.some("701"))),
      Story.Command.expectExact(Repositories.FetchDetail({ repositoryId: "701" })),
      Story.Command.resolve(
        Repositories.FetchDetail({ repositoryId: "701" }),
        Repositories.Message.GotDetail({ repositoryId: "701", detail }),
      ),
      Story.model((next) => expect(next.detail).toEqual(Option.some(detail))),
    )
  })

  it("drops a late answer for a repository that is no longer selected", () => {
    const { model } = Repositories.init()
    Story.story(
      Repositories.update,
      Story.given({ ...model, selected: Option.some("701"), detail: Option.some(detail) }),
      Story.message(Repositories.Message.Selected({ repositoryId: "702" })),
      Story.model((next) => {
        expect(next.selected).toEqual(Option.some("702"))
        expect(next.detail).toEqual(Option.none())
      }),
      Story.Command.expectExact(Repositories.FetchDetail({ repositoryId: "702" })),
      // The stale answer for 701 lands while 702 is selected.
      Story.Command.resolve(
        Repositories.FetchDetail({ repositoryId: "702" }),
        Repositories.Message.GotDetail({ repositoryId: "701", detail }),
      ),
      Story.model((next) => expect(next.detail).toEqual(Option.none())),
    )
  })

  it("describes revisions and plans for people", () => {
    expect(Repositories.describeRevision(configuration)).toBe("Revision 1 active")
    expect(
      Repositories.describeRevision({
        ...configuration,
        activeRevision: null,
        pendingTracks: ["labels"],
      }),
    ).toBe("Revision 1 waiting on labels")
    expect(Repositories.describeRevision({ ...configuration, configuredRevision: 0 })).toBe(
      "Nothing configured",
    )
    expect(
      Repositories.describePlan(
        detail.reconciliations[0]!.plan!,
        configuration.labels,
        configuration.rules,
        configuration.policies,
      ),
    ).toEqual(["add bug (Base is main)"])
  })
})
