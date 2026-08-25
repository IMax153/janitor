import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as Command from "foldkit/command"
import * as Runtime from "foldkit/runtime"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Subscription from "foldkit/subscription"
import * as Update from "foldkit/update"
import * as Sidebar from "@/components/ui/sidebar"
import * as ThemeSwitcher from "@/components/theme-switcher"

// MODEL

export const Model = Schema.Struct({
  sidebar: Sidebar.Model,
  theme: ThemeSwitcher.Model,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  GotSidebarMessage: {
    message: Sidebar.Message,
  },
  GotThemeSwitcherMessage: {
    message: ThemeSwitcher.Message,
  },
})
export type Message = typeof Message.Type

// FLAGS

export const Flags = Schema.Struct({
  theme: ThemeSwitcher.Flags,
})
export type Flags = typeof Flags.Type

export const flags = Effect.gen(function* () {
  const theme = yield* ThemeSwitcher.flags
  return Flags.make({ theme }, { disableChecks: true })
})

// UPDATE

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

// INIT

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

// SUBSCRIPTIONS

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

// VIEW

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
      content: () => [
        Sidebar.header(h, { children: ["Header"] }),
        Sidebar.content(h, { children: ["Content"] }),
        Sidebar.footer(h, { children: ["Footer"] }),
      ],
      children: (slots) => [
        Sidebar.inset(h, {
          children: [
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
            ),
          ],
        }),
      ],
    },
  }),
})
