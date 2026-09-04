import * as Popover from "@foldkit/ui/popover"
import * as Array from "effect/Array"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as FoldkitCommand from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import * as Update from "foldkit/update"
import { Check, ChevronsUpDown, CircleSlash, TriangleAlert } from "lucide"
import type { RepositoryOverview } from "@/components/labeling-wire"
import * as CommandPalette from "@/components/ui/command"
import * as Sidebar from "@/components/ui/sidebar"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"

/**
 * The repository switcher under the sidebar's brand header. The trigger shows
 * the selected repository; pressing it opens a command palette listing every
 * repository the installation can see, grouped by owner.
 */

const POPOVER_ID = "repository-switcher"

// MODEL

export const Model = Schema.Struct({
  popover: Popover.Model,
  /** What is typed in the palette's search box. */
  search: Schema.String,
})
export type Model = typeof Model.Type

export type ViewInputs = {
  readonly repositories: ReadonlyArray<RepositoryOverview>
  readonly maybeSelectedId: Option.Option<string>
}

// MESSAGE

export const Message = defineMessageUnion({
  GotPopoverMessage: { message: Popover.Message },
  ChangedSearch: { search: Schema.String },
  ClickedRepository: { repositoryId: Schema.String },
})
export type Message = typeof Message.Type

/** The switcher owns the palette, not the selection. The parent decides what
 *  picking a repository means. */
export const OutMessage = defineMessageUnion({
  SelectedRepository: { repositoryId: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// INIT

export const init = (): Model =>
  Model.make({ popover: Popover.init({ id: POPOVER_ID }), search: "" })

// UPDATE

const foldPopoverOutMessage = Match.type<Popover.OutMessage>().pipe(
  Match.withReturnType<Update.Step<Model, Message>>(),
  Match.tagsExhaustive({
    Opened: () => (model) => ({ model }),
    // Leaving the search text behind would show the last query the next time
    // the palette opens, with the full list hidden behind it.
    Closed: () => (model) => ({ model: evo(model, { search: () => "" }) }),
  }),
)

const foldPopover = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.popover),
  write: (model, next) => evo(model, { popover: () => next }),
  toParentMessage: (message) => Message.GotPopoverMessage({ message }),
  foldOutMessage: foldPopoverOutMessage,
})

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotPopoverMessage: ({ message }) => foldPopover(model, message),
    ChangedSearch: ({ search }) => ({ model: evo(model, { search: () => search }) }),
    ClickedRepository: ({ repositoryId }) => {
      // Close through the popover's own update so it runs its focus and
      // animation commands rather than having the flag flipped underneath it.
      const closed = Popover.close(model.popover)
      return {
        model: evo(model, { popover: () => closed.model, search: () => "" }),
        commands: FoldkitCommand.mapMessages(closed.commands ?? [], (message) =>
          Message.GotPopoverMessage({ message }),
        ),
        outMessage: OutMessage.SelectedRepository({ repositoryId }),
      }
    },
  })

// SEARCH AND GROUPING

/** `owner/repo`, so typing either side of the slash narrows the list. */
export const matches = (repository: RepositoryOverview, search: string): boolean => {
  const query = search.trim().toLowerCase()
  return query === "" || `${repository.owner}/${repository.repo}`.toLowerCase().includes(query)
}

export type Group = {
  readonly owner: string
  readonly repositories: ReadonlyArray<RepositoryOverview>
}

/** Groups by owner, sorted by owner then repository, so the palette lists the
 *  same thing in the same order every time it opens. */
export const groupByOwner = (
  repositories: ReadonlyArray<RepositoryOverview>,
): ReadonlyArray<Group> => {
  const byOwner = new Map<string, Array<RepositoryOverview>>()
  for (const repository of repositories) {
    const existing = byOwner.get(repository.owner)
    if (existing === undefined) {
      byOwner.set(repository.owner, [repository])
    } else {
      existing.push(repository)
    }
  }
  return [...byOwner.entries()]
    .map(([owner, group]) => ({
      owner,
      repositories: [...group].sort((left, right) => left.repo.localeCompare(right.repo)),
    }))
    .sort((left, right) => left.owner.localeCompare(right.owner))
}

// VIEW

/** The tile letters: the first two of the repository name, uppercased.
 *  `effect` reads as `EF`. */
export const initials = (name: string): string => {
  const letters = name.replace(/[^A-Za-z0-9]/g, "")
  return (letters.slice(0, 2) || name.slice(0, 2)).toUpperCase()
}

const tile = (h: HtmlBuilder<Message>, text: string, className?: string): Html =>
  h.div(
    [
      h.Class(
        cn(
          "bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold",
          className,
        ),
      ),
    ],
    [text],
  )

/**
 * What a repository is doing right now, in one line.
 *
 * `access` comes first because a repository GitHub will not talk to cannot be
 * labeled whatever else is true of it. Then whether labeling is on, and only
 * then the published revision, which is the least urgent of the three.
 */
export const statusText = (repository: RepositoryOverview): string => {
  if (repository.access === "lost") return "No access"
  if (repository.access === "suspect") return "Access failing"
  if (!repository.enabled) return "Disabled"
  if (repository.activeRevision === null) return "Enabled, not configured"
  return `Enabled, revision ${repository.activeRevision}`
}

const statusIcon = (h: HtmlBuilder<Message>, repository: RepositoryOverview): Html => {
  if (repository.access === "lost" || repository.access === "suspect") {
    return Icon.view(h, TriangleAlert, "size-3 shrink-0 text-amber-500")
  }
  if (!repository.enabled) {
    return Icon.view(h, CircleSlash, "size-3 shrink-0 opacity-50")
  }
  return h.empty
}

const statusLine = (h: HtmlBuilder<Message>, repository: RepositoryOverview): Html =>
  h.span(
    [h.Class("text-muted-foreground flex items-center gap-1 truncate text-xs")],
    [statusIcon(h, repository), h.span([h.Class("truncate")], [statusText(repository)])],
  )

const repositoryRow = (
  h: HtmlBuilder<Message>,
  repository: RepositoryOverview,
  isSelected: boolean,
): Html =>
  CommandPalette.item(h, {
    isSelected,
    className: "cursor-pointer gap-2",
    attributes: [
      h.OnClick(Message.ClickedRepository({ repositoryId: repository.repositoryId })),
      h.DataAttribute("repository", repository.repositoryId),
    ],
    children: [
      tile(h, initials(repository.repo), "size-6 rounded-md text-[10px]"),
      h.span(
        [h.Class("grid min-w-0 flex-1 leading-tight")],
        [h.span([h.Class("truncate font-medium")], [repository.repo]), statusLine(h, repository)],
      ),
      isSelected ? Icon.view(h, Check, "size-4 shrink-0") : h.empty,
    ],
  })

const ownerGroup = (
  h: HtmlBuilder<Message>,
  group: Group,
  maybeSelectedId: Option.Option<string>,
): Html =>
  CommandPalette.group(h, {
    heading: group.owner,
    children: group.repositories.map((repository) =>
      repositoryRow(h, repository, Option.contains(maybeSelectedId, repository.repositoryId)),
    ),
  })

const paletteBody = (
  h: HtmlBuilder<Message>,
  { repositories, maybeSelectedId }: ViewInputs,
  search: string,
): ReadonlyArray<Html> => {
  const visible = repositories.filter((repository) => matches(repository, search))
  if (visible.length === 0) {
    return [
      CommandPalette.empty(h, {
        children: [
          repositories.length === 0
            ? "No repositories yet."
            : `Nothing matches "${search.trim()}".`,
        ],
      }),
    ]
  }
  return groupByOwner(visible).map((group) => ownerGroup(h, group, maybeSelectedId))
}

const palette = (h: HtmlBuilder<Message>, model: Model, inputs: ViewInputs): Html =>
  CommandPalette.container(h, {
    className: "w-72 rounded-lg! border shadow-md",
    children: [
      CommandPalette.input(h, {
        value: model.search,
        placeholder: "Search repositories...",
        onInput: (search) => Message.ChangedSearch({ search }),
      }),
      CommandPalette.list(h, { children: paletteBody(h, inputs, model.search) }),
    ],
  })

const triggerLabel = (h: HtmlBuilder<Message>, inputs: ViewInputs): Html => {
  const maybeSelected = Option.flatMap(inputs.maybeSelectedId, (repositoryId) =>
    Array.findFirst(inputs.repositories, (candidate) => candidate.repositoryId === repositoryId),
  )
  return Option.match(maybeSelected, {
    onNone: () =>
      h.div(
        [h.Class("flex min-w-0 flex-1 items-center gap-2")],
        [
          tile(h, "--"),
          h.span(
            [h.Class("grid min-w-0 flex-1 text-left leading-tight")],
            [
              h.span([h.Class("truncate font-medium")], ["No repository"]),
              h.span([h.Class("text-muted-foreground truncate text-xs")], ["Select one"]),
            ],
          ),
        ],
      ),
    onSome: (repository) =>
      h.div(
        [h.Class("flex min-w-0 flex-1 items-center gap-2")],
        [
          tile(h, initials(repository.repo)),
          h.span(
            [h.Class("grid min-w-0 flex-1 text-left leading-tight")],
            [
              h.span([h.Class("truncate font-medium")], [repository.repo]),
              statusLine(h, repository),
            ],
          ),
        ],
      ),
  })
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.submodel({
    slotId: POPOVER_ID,
    model: model.popover,
    view: Popover.view,
    toParentMessage: (message) => Message.GotPopoverMessage({ message }),
    viewInputs: {
      anchor: { placement: "bottom-start", gap: 4, padding: 8 },
      ariaLabel: "Switch repository",
      focusSelector: "[data-slot=command-input]",
      toView: (render) =>
        h.div(
          [],
          [
            Sidebar.menuButton(h, {
              size: "lg",
              attributes: [...render.button],
              // Mixing `--sidebar` toward black darkens it the same way in
              // either theme, which `--background` does not: that token is
              // lighter than the sidebar in light mode and darker in dark.
              // Hover then lands on `--sidebar-accent` from the base menu
              // button class, which is lighter than this fill in both
              // themes, so the button brightens on the way in.
              className:
                "border border-sidebar-border bg-[color-mix(in_oklch,var(--sidebar),black_4%)] shadow-xs data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground",
              children: [
                triggerLabel(h, inputs),
                Icon.view(h, ChevronsUpDown, "ml-auto size-4 shrink-0 opacity-50"),
              ],
            }),
            // The backdrop is what closes the palette on an outside click:
            // its bundle carries an OnClick that requests the close, and a
            // Mount that portals it to the document body so it covers the
            // page rather than the sidebar. Skip it and the only ways out
            // are Escape and the trigger.
            ...(render.isVisible
              ? [
                  h.div([...render.backdrop, h.Class("fixed inset-0 z-40")], []),
                  h.div([...render.panel, h.Class("z-50")], [palette(h, model, inputs)]),
                ]
              : []),
          ],
        ),
    },
  }),
)
