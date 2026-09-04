import * as Popover from "@foldkit/ui/popover"
import * as Option from "effect/Option"
import { Scene } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import type { RepositoryOverview } from "@/components/labeling-wire"
import * as RepositorySwitcher from "@/components/repository-switcher"

const repository = (
  overrides: Partial<RepositoryOverview> & Pick<RepositoryOverview, "repositoryId" | "repo">,
): RepositoryOverview => ({
  owner: "Effectful-Tech",
  enabled: true,
  access: "accessible",
  configuredRevision: 1,
  activeRevision: 1,
  ...overrides,
})

const effect = repository({ repositoryId: "701", repo: "effect" })
const janitor = repository({
  repositoryId: "702",
  repo: "janitor",
  enabled: false,
  configuredRevision: null,
  activeRevision: null,
})
const website = repository({
  repositoryId: "703",
  repo: "website",
  owner: "vercel",
  access: "lost",
})

const repositories = [effect, janitor, website]

const sceneView = Scene.withViewInputs(RepositorySwitcher.view, {
  repositories,
  maybeSelectedId: Option.some("701"),
})

/** The palette only renders while the popover is open. */
const opened = (): RepositorySwitcher.Model =>
  RepositorySwitcher.update(
    RepositorySwitcher.init(),
    RepositorySwitcher.Message.GotPopoverMessage({ message: Popover.Message.RequestedOpen() }),
  ).model

const searched = (search: string): RepositorySwitcher.Model =>
  RepositorySwitcher.update(opened(), RepositorySwitcher.Message.ChangedSearch({ search })).model

const mounts = [
  Scene.Mount.resolve(Popover.AnchorPopover, Popover.Message.CompletedAnchorPopover()),
  Scene.Mount.resolve(
    Popover.PortalPopoverBackdrop,
    Popover.Message.CompletedPortalPopoverBackdrop(),
  ),
] as const

describe("RepositorySwitcher", () => {
  it("takes the tile letters from the repository name", () => {
    expect(RepositorySwitcher.initials("effect")).toBe("EF")
    expect(RepositorySwitcher.initials("janitor")).toBe("JA")
    expect(RepositorySwitcher.initials("-x")).toBe("X")
  })

  it("groups by owner and sorts both levels", () => {
    expect(
      RepositorySwitcher.groupByOwner([website, janitor, effect]).map((group) => [
        group.owner,
        group.repositories.map((each) => each.repo),
      ]),
    ).toEqual([
      ["Effectful-Tech", ["effect", "janitor"]],
      ["vercel", ["website"]],
    ])
  })

  it("matches on either side of the slash", () => {
    expect(RepositorySwitcher.matches(effect, "")).toBe(true)
    expect(RepositorySwitcher.matches(effect, "EFFE")).toBe(true)
    expect(RepositorySwitcher.matches(effect, "effectful")).toBe(true)
    expect(RepositorySwitcher.matches(effect, "vercel")).toBe(false)
  })

  it("says what each repository is doing, worst news first", () => {
    expect(RepositorySwitcher.statusText(effect)).toBe("Enabled, revision 1")
    expect(RepositorySwitcher.statusText(janitor)).toBe("Disabled")
    // Lost access outranks being enabled.
    expect(RepositorySwitcher.statusText(website)).toBe("No access")
    expect(RepositorySwitcher.statusText({ ...effect, activeRevision: null })).toBe(
      "Enabled, not configured",
    )
  })

  it("shows the selected repository on the trigger", () => {
    Scene.scene(
      { update: RepositorySwitcher.update, view: sceneView() },
      Scene.given(RepositorySwitcher.init()),
      Scene.expect(Scene.text("EF")).toExist(),
      Scene.expect(Scene.text("effect")).toExist(),
      Scene.expect(Scene.text("Enabled, revision 1")).toExist(),
    )
  })

  it("sets the trigger off from the rest of the sidebar", () => {
    Scene.scene(
      { update: RepositorySwitcher.update, view: sceneView() },
      Scene.given(RepositorySwitcher.init()),
      Scene.expect(Scene.role("button")).toHaveClass("border"),
      Scene.expect(Scene.role("button")).toHaveClass(
        "bg-[color-mix(in_oklch,var(--sidebar),black_4%)]",
      ),
    )
  })

  it("keeps the palette closed until the trigger is pressed", () => {
    Scene.scene(
      { update: RepositorySwitcher.update, view: sceneView() },
      Scene.given(RepositorySwitcher.init()),
      Scene.expect(Scene.placeholder("Search repositories...")).toBeAbsent(),
    )
  })

  it("lists every repository under its owner", () => {
    Scene.scene(
      { update: RepositorySwitcher.update, view: sceneView() },
      Scene.given(opened()),
      Scene.expect(Scene.placeholder("Search repositories...")).toExist(),
      Scene.expect(Scene.text("Effectful-Tech")).toExist(),
      Scene.expect(Scene.text("vercel")).toExist(),
      Scene.expect(Scene.text("janitor")).toExist(),
      Scene.expect(Scene.text("Disabled")).toExist(),
      Scene.expect(Scene.text("No access")).toExist(),
      ...mounts,
    )
  })

  it("narrows the list as you type, and drops empty groups with it", () => {
    Scene.scene(
      { update: RepositorySwitcher.update, view: sceneView() },
      Scene.given(searched("janit")),
      Scene.expect(Scene.text("janitor")).toExist(),
      Scene.expect(Scene.text("website")).toBeAbsent(),
      Scene.expect(Scene.text("vercel")).toBeAbsent(),
      ...mounts,
    )
  })

  it("says so when nothing matches", () => {
    Scene.scene(
      { update: RepositorySwitcher.update, view: sceneView() },
      Scene.given(searched("nothing-by-this-name")),
      Scene.expect(Scene.text('Nothing matches "nothing-by-this-name".')).toExist(),
      ...mounts,
    )
  })

  it("reports the pick to the parent and closes", () => {
    Scene.scene(
      { update: RepositorySwitcher.update, view: sceneView() },
      Scene.given(opened()),
      ...mounts,
      Scene.click(`[data-repository="702"]`),
      Scene.expectOutMessage(
        RepositorySwitcher.OutMessage.SelectedRepository({ repositoryId: "702" }),
      ),
      Scene.Command.resolve(Popover.FocusButton, Popover.Message.CompletedFocusButton()),
      Scene.expect(Scene.placeholder("Search repositories...")).toBeAbsent(),
      Scene.Mount.expectEnded(Popover.AnchorPopover, Popover.PortalPopoverBackdrop),
    )
  })

  it("closes the palette when the click lands outside it", () => {
    Scene.scene(
      { update: RepositorySwitcher.update, view: sceneView() },
      Scene.given(opened()),
      ...mounts,
      Scene.click(".fixed.inset-0"),
      Scene.Command.resolve(Popover.FocusButton, Popover.Message.CompletedFocusButton()),
      Scene.expect(Scene.placeholder("Search repositories...")).toBeAbsent(),
      Scene.Mount.expectEnded(Popover.AnchorPopover, Popover.PortalPopoverBackdrop),
    )
  })

  it("forgets the search text once the palette closes", () => {
    const closed = RepositorySwitcher.update(
      searched("janit"),
      RepositorySwitcher.Message.GotPopoverMessage({ message: Popover.Message.RequestedClose() }),
    )
    expect(closed.model.search).toBe("")
  })
})
