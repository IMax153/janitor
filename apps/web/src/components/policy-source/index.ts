import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { Html } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Mount from "foldkit/mount"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import type * as Update from "foldkit/update"
import { FactDescription } from "@/components/labeling-wire"

/**
 * The policy source editor as a Submodel. CodeMirror owns the DOM inside
 * one element mounted through Foldkit's mount seam; every document change
 * flows back as a Message, so the Model always holds the current source.
 */

// MODEL

export const MountStatus = Schema.Literals(["Mounting", "Ready", "Failed"])

export const Model = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  /** A JSON parse error, if the source is not an object right now. */
  maybeParseError: Schema.Option(Schema.String),
  mountStatus: MountStatus,
  catalog: Schema.Array(FactDescription),
  policyNames: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  MountedEditor: {},
  FailedToMountEditor: { reason: Schema.String },
  EditedSource: { source: Schema.String },
})
export type Message = typeof Message.Type

// MOUNT

export const MountPolicySourceEditor = Mount.defineStream("MountPolicySourceEditor", {
  args: {
    id: Schema.String,
    initialSource: Schema.String,
    catalog: Schema.Array(FactDescription),
    policyNames: Schema.Array(Schema.String),
  },
  messages: [Message.MountedEditor, Message.FailedToMountEditor, Message.EditedSource],
  execute: ({ element, initialSource, catalog, policyNames }) =>
    Stream.callback((queue) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            if (!(element instanceof HTMLElement)) {
              throw new Error("The policy editor host must be an HTMLElement")
            }
            const { createPolicySourceEditor } = await import("./editor")
            const editor = createPolicySourceEditor({
              element,
              initialSource,
              context: { catalog, policyNames },
              onChange: (source) => {
                Queue.offerUnsafe(queue, Message.EditedSource({ source }))
              },
            })
            Queue.offerUnsafe(queue, Message.MountedEditor())
            return editor
          },
          catch: (error) =>
            error instanceof Error ? error.message : "The policy editor failed to mount",
        }),
        (editor) => Effect.sync(() => editor.destroy()),
      ).pipe(
        Effect.flatMap(() => Effect.never),
        Effect.catch((reason) =>
          Effect.sync(() => {
            Queue.offerUnsafe(queue, Message.FailedToMountEditor({ reason }))
          }),
        ),
      ),
    ),
})

// INIT

export const init = (input: {
  readonly id: string
  readonly source: string
  readonly catalog: ReadonlyArray<FactDescription>
  readonly policyNames: ReadonlyArray<string>
}): Model =>
  Model.make(
    {
      id: input.id,
      source: input.source,
      maybeParseError: parseError(input.source),
      mountStatus: "Mounting",
      catalog: input.catalog,
      policyNames: input.policyNames,
    },
    { disableChecks: true },
  )

export const parseError = (source: string): Option.Option<string> => {
  try {
    const value: unknown = JSON.parse(source)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? Option.none()
      : Option.some("The program must be a JSON object")
  } catch (error) {
    return Option.some(error instanceof Error ? error.message : "Invalid JSON")
  }
}

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    MountedEditor: () => ({ model: evo(model, { mountStatus: () => "Ready" as const }) }),
    FailedToMountEditor: ({ reason }) => ({
      model: evo(model, {
        mountStatus: () => "Failed" as const,
        maybeParseError: () => Option.some(reason),
      }),
    }),
    EditedSource: ({ source }) => ({
      model: evo(model, { source: () => source, maybeParseError: () => parseError(source) }),
    }),
  })

// VIEW

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  h.div(
    [
      h.Id(model.id),
      h.Class(
        "overflow-hidden rounded-md border bg-background transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
      ),
      h.OnMount(
        MountPolicySourceEditor({
          id: model.id,
          initialSource: model.source,
          catalog: model.catalog,
          policyNames: model.policyNames,
        }),
      ),
    ],
    [],
  ),
)
