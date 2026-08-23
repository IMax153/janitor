import { Schema as S } from "effect"
import { Command, Runtime } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Button from "@/components/ui/button"
import * as Icon from "@/lib/icons"
import { Minus, Plus } from "lucide"

// MODEL

export const Model = S.Struct({ count: S.Number })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedDecrement: {},
  ClickedIncrement: {},
  ClickedReset: {},
})
export type Message = typeof Message.Type

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(message, {
    ClickedDecrement: () => [evo(model, { count: (count) => count - 1 }), []],
    ClickedIncrement: () => [evo(model, { count: (count) => count + 1 }), []],
    ClickedReset: () => [evo(model, { count: () => 0 }), []],
  })

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => [{ count: 0 }, []]

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `Counter: ${model.count}`,
  body: h.div(
    [h.Class("min-h-screen flex flex-col items-center justify-center gap-6 p-6")],
    [
      h.p([h.Class("text-6xl font-bold text-gray-800")], [model.count.toString()]),
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
