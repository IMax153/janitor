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
import { Minus, Plus } from "lucide"
import * as Button from "@/components/ui/button"
import * as ThemeSwitcher from "@/components/theme-switcher"
import * as Icon from "@/lib/icons"

// MODEL

export const Model = Schema.Struct({
  count: Schema.Number,
  theme: ThemeSwitcher.Model,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedDecrement: {},
  ClickedIncrement: {},
  ClickedReset: {},
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

const foldThemeSwitcher = Update.foldChild({
  update: ThemeSwitcher.update,
  read: (model: Model) => Option.some(model.theme),
  write: (model, next) => evo(model, { theme: () => next }),
  toParentMessage: (message) => Message.GotThemeSwitcherMessage({ message }),
})

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, AppResources>>(message, {
    ClickedDecrement: () => [evo(model, { count: (count) => count - 1 }), []],
    ClickedIncrement: () => [evo(model, { count: (count) => count + 1 }), []],
    ClickedReset: () => [evo(model, { count: () => 0 }), []],
    GotThemeSwitcherMessage: ({ message }) => foldThemeSwitcher(model, message),
  })

// INIT

export type AppResources = KeyValueStore.KeyValueStore

export const init: Runtime.ApplicationInit<Model, Message, Flags, AppResources> = (
  flags: Flags,
) => {
  const [theme, themeCommands] = ThemeSwitcher.init(flags.theme)
  return [
    { count: 0, theme },
    [
      ...Command.mapMessages(themeCommands, (message) =>
        Message.GotThemeSwitcherMessage({ message }),
      ),
    ],
  ]
}

// SUBSCRIPTIONS

export const subscriptions = Subscription.lift(ThemeSwitcher.subscriptions)<Model, Message>({
  toChildModel: (model) => model.theme,
  toParentMessage: (message) => Message.GotThemeSwitcherMessage({ message }),
})

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `Counter: ${model.count}`,
  body: h.div(
    [h.Class("min-h-screen flex flex-col items-center justify-center gap-6 p-6")],
    [
      h.div(
        [],
        [
          h.submodel({
            slotId: "theme-switcher",
            model: model.theme,
            view: ThemeSwitcher.view,
            toParentMessage: (message) => Message.GotThemeSwitcherMessage({ message }),
          }),
        ],
      ),
      h.p([h.Class("text-6xl font-bold text-foreground")], [model.count.toString()]),
      h.div(
        [h.Class("flex flex-wrap justify-center gap-4")],
        [
          Button.view(h, {
            label: Icon.view(h, Minus),
            onClick: Message.ClickedDecrement(),
          }),
          Button.view(h, {
            label: "Reset",
            onClick: Message.ClickedReset(),
          }),
          Button.view(h, {
            label: Icon.view(h, Plus),
            onClick: Message.ClickedIncrement(),
          }),
        ],
      ),
    ],
  ),
})
