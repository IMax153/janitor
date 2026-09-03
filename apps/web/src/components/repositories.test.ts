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

const rules: Repositories.RulesetView = {
  repositoryId: "701",
  configuredRevision: 1,
  configured: {
    rules: [
      {
        id: "base-main",
        name: "Base is main",
        enabled: true,
        target: "pull_request",
        evaluator: { _tag: "Concrete", predicates: [{ _tag: "BaseBranchIs", ref: "main" }] },
        labels: ["11"],
      },
    ],
  },
  activeRevision: 1,
  pendingTracks: [],
  labels: [{ labelId: "11", name: "bug", availability: "available" }],
  labelFreshness: "verified",
}

const detail: Repositories.RepositoryDetail = {
  rules,
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
      detail: "no rules evaluated yet",
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

  it("describes revisions and predicates for people", () => {
    expect(Repositories.describeRevision(rules)).toBe("Revision 1 active")
    expect(
      Repositories.describeRevision({ ...rules, activeRevision: null, pendingTracks: ["labels"] }),
    ).toBe("Revision 1 waiting on labels")
    expect(Repositories.describeRevision({ ...rules, configuredRevision: 0 })).toBe(
      "No rules saved",
    )
    expect(Repositories.describePredicate({ _tag: "DraftStateIs", draft: false })).toBe(
      "is not a draft",
    )
  })
})
