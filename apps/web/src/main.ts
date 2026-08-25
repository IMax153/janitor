import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as Command from "foldkit/command"
import * as Runtime from "foldkit/runtime"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Subscription from "foldkit/subscription"
import * as Update from "foldkit/update"
import * as JanitorIcon from "@/components/janitor-icon"
import * as Sidebar from "@/components/ui/sidebar"
import * as ThemeSwitcher from "@/components/theme-switcher"

export const Model = Schema.Struct({
  sidebar: Sidebar.Model,
  theme: ThemeSwitcher.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  GotSidebarMessage: {
    message: Sidebar.Message,
  },
  GotThemeSwitcherMessage: {
    message: ThemeSwitcher.Message,
  },
})
export type Message = typeof Message.Type

export const Flags = Schema.Struct({
  theme: ThemeSwitcher.Flags,
})
export type Flags = typeof Flags.Type

export const flags = Effect.gen(function* () {
  const theme = yield* ThemeSwitcher.flags
  return Flags.make({ theme }, { disableChecks: true })
})

const foldSidebar = Update.foldChild({
  update: Sidebar.update,
  read: (model: Model) => Option.some(model.sidebar),
  write: (model, next) => evo(model, { sidebar: () => next }),
  toParentMessage: (message) => Message.GotSidebarMessage({ message }),
})

const foldThemeSwitcher = Update.foldChild({
  update: ThemeSwitcher.update,
  read: (model: Model) => Option.some(model.theme),
  write: (model, next) => evo(model, { theme: () => next }),
  toParentMessage: (message) => Message.GotThemeSwitcherMessage({ message }),
})

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, AppServices>>(message, {
    GotSidebarMessage: ({ message }) => foldSidebar(model, message),
    GotThemeSwitcherMessage: ({ message }) => foldThemeSwitcher(model, message),
  })

export type AppServices = KeyValueStore.KeyValueStore

export const init: Runtime.ApplicationInit<Model, Message, Flags, AppServices> = (flags: Flags) => {
  const [theme, themeCommands] = ThemeSwitcher.init(flags.theme)
  const sidebar = Sidebar.init({ id: "app-sidebar" })
  return [
    { sidebar, theme },
    [
      ...Command.mapMessages(themeCommands, (message) =>
        Message.GotThemeSwitcherMessage({ message }),
      ),
    ],
  ]
}

const sidebarSubscriptions = Subscription.lift(Sidebar.subscriptions)<Model, Message>({
  toChildModel: (model) => model.sidebar,
  toParentMessage: (message) => Message.GotSidebarMessage({ message }),
})

const themeSubscriptions = Subscription.lift(ThemeSwitcher.subscriptions)<Model, Message>({
  toChildModel: (model) => model.theme,
  toParentMessage: (message) => Message.GotThemeSwitcherMessage({ message }),
})

export const subscriptions = Subscription.aggregate<Model, Message, AppServices>()(
  sidebarSubscriptions,
  themeSubscriptions,
)

const sidebarBrand = (h: HtmlBuilder<Message>): Html =>
  h.a(
    [h.Href("/"), h.Class("flex h-8 w-full items-center gap-2 overflow-hidden")],
    [
      JanitorIcon.view(h, { className: "size-8 shrink-0 rounded-lg" }),
      h.span(
        [
          h.Class(
            "grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden",
          ),
        ],
        [
          h.span([h.Class("truncate font-semibold")], ["The Janitor"]),
          h.span([h.Class("text-muted-foreground truncate text-xs")], ["Repository Maintenance"]),
        ],
      ),
    ],
  )

const sidebarPanel = (h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  Sidebar.header(h, { children: [sidebarBrand(h)] }),
  Sidebar.content(h, { children: ["Content"] }),
  Sidebar.footer(h, { children: ["Footer"] }),
]

const mainHeader = (h: HtmlBuilder<Message>, model: Model, slots: Sidebar.SidebarSlots): Html =>
  h.header(
    [
      h.Class(
        "flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear",
      ),
    ],
    [
      h.div(
        [h.Class("w-full flex justify-between px-4 lg:px-6")],
        [
          h.div(
            [h.Class("flex items-center gap-1 lg:gap-2")],
            [
              Sidebar.trigger(h, {
                attributes: slots.trigger,
                className: "-ml-1",
              }),
              Sidebar.separator(h, { className: "h-4 w-px" }),
              h.span(
                [h.Class("text-sm font-medium")],
                [
                  slots.state === "collapsed"
                    ? "Collapsed — hover the icons or press ⌘B"
                    : "Acme Inc — Playground / Starred",
                ],
              ),
            ],
          ),
          h.submodel({
            slotId: "theme-switcher",
            model: model.theme,
            view: ThemeSwitcher.view,
            toParentMessage: (message) => Message.GotThemeSwitcherMessage({ message }),
          }),
        ],
      ),
    ],
  )

const sidebarContent = (
  h: HtmlBuilder<Message>,
  model: Model,
  slots: Sidebar.SidebarSlots,
): ReadonlyArray<Html> => [
  Sidebar.inset(h, {
    children: [mainHeader(h, model, slots)],
  }),
]

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "The Jailer",
  body: h.submodel({
    slotId: "app-sidebar",
    model: model.sidebar,
    view: Sidebar.view,
    toParentMessage: (message) => Message.GotSidebarMessage({ message }),
    viewInputs: {
      side: "left",
      variant: "inset",
      collapsible: "icon",
      content: () => sidebarPanel(h),
      children: (slots) => sidebarContent(h, model, slots),
    },
  }),
})
