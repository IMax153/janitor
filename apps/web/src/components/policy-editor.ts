import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as FoldkitCommand from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import * as Update from "foldkit/update"
import * as Button from "@/components/ui/button"
import { input, inputClass } from "@/components/ui/input"
import * as PolicySource from "@/components/policy-source"
import {
  FactDescription,
  formatSource,
  Manifest,
  PolicyDetail,
  policiesEndpoint,
  policyEndpoint,
  ProgramSource,
  publishEndpoint,
  validateEndpoint,
  ValidatePolicyResponse,
} from "@/components/labeling-wire"
import { cn } from "@/lib/utils"

/**
 * The policy editor (plan: "User interface"). Name, description, and the
 * source editor. Validate asks the server to compile the draft and shows
 * the manifest. Save keeps a draft; Publish saves then publishes.
 */

// MODEL

export const Identity = Schema.Union([
  Schema.TaggedStruct("New", {}),
  Schema.TaggedStruct("Existing", { policyId: Schema.String, version: Schema.Int }),
])
export type Identity = typeof Identity.Type

export const Validation = Schema.Union([
  Schema.TaggedStruct("NotValidated", {}),
  Schema.TaggedStruct("Validating", {}),
  Schema.TaggedStruct("Valid", { manifest: Manifest }),
  Schema.TaggedStruct("Invalid", { message: Schema.String }),
])
export type Validation = typeof Validation.Type

export const Submission = Schema.Union([
  Schema.TaggedStruct("NotSubmitted", {}),
  Schema.TaggedStruct("Submitting", { publish: Schema.Boolean }),
  Schema.TaggedStruct("Conflicted", {}),
  Schema.TaggedStruct("SubmitError", { message: Schema.String }),
])
export type Submission = typeof Submission.Type

export const Model = Schema.Struct({
  repositoryId: Schema.String,
  identity: Identity,
  name: Schema.String,
  description: Schema.String,
  source: PolicySource.Model,
  validation: Validation,
  submission: Submission,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedName: { value: Schema.String },
  UpdatedDescription: { value: Schema.String },
  GotSourceMessage: { message: PolicySource.Message },
  ClickedValidate: {},
  CompletedValidate: { response: ValidatePolicyResponse },
  FailedValidate: { reason: Schema.String },
  ClickedSave: {},
  ClickedPublish: {},
  SucceededSavePolicy: { detail: PolicyDetail, published: Schema.Boolean },
  ConflictedSavePolicy: { detail: PolicyDetail },
  RejectedSavePolicy: { message: Schema.String },
  FailedSavePolicy: { reason: Schema.String },
  ClickedCancel: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  Saved: { detail: PolicyDetail, published: Schema.Boolean },
  Cancelled: {},
  SaveFailed: { reason: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// DOMAIN

/** The source parsed as the authoring shape, when it parses at all. */
export const parsedSource = (model: Model): Option.Option<ProgramSource> =>
  Option.isSome(model.source.maybeParseError)
    ? Option.none()
    : Schema.decodeUnknownOption(ProgramSource)(JSON.parse(model.source.source))

export const draftIssues = (model: Model): ReadonlyArray<string> => [
  ...(model.name.trim().length === 0 ? ["Name is required"] : []),
  ...Option.match(model.source.maybeParseError, {
    onNone: () =>
      Option.isNone(parsedSource(model)) ? ["The program needs a target and a matchesWhen"] : [],
    onSome: (message) => [message],
  }),
]

const isSubmitting = (model: Model) => model.submission._tag === "Submitting"

// COMMAND

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error)

const MessageBody = Schema.Struct({ message: Schema.String })

export const ValidateDraft = FoldkitCommand.define("ValidateDraft", {
  args: { repositoryId: Schema.String, source: ProgramSource },
  messages: [Message.CompletedValidate, Message.FailedValidate],
  execute: ({ repositoryId, source }) =>
    HttpClientRequest.post(validateEndpoint(repositoryId)).pipe(
      HttpClientRequest.bodyJson({ source }),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(ValidatePolicyResponse)),
      Effect.map((response) => Message.CompletedValidate({ response })),
      Effect.catch((error) => Effect.succeed(Message.FailedValidate({ reason: describe(error) }))),
    ),
})

const SavePayload = Schema.Struct({
  repositoryId: Schema.String,
  identity: Identity,
  name: Schema.String,
  description: Schema.String,
  source: ProgramSource,
  publish: Schema.Boolean,
})

/** Creates or saves the draft, then publishes when asked. Each answer is one Message. */
export const SavePolicy = FoldkitCommand.define("SavePolicy", {
  args: SavePayload.fields,
  messages: [
    Message.SucceededSavePolicy,
    Message.ConflictedSavePolicy,
    Message.RejectedSavePolicy,
    Message.FailedSavePolicy,
  ],
  execute: ({ repositoryId, identity, name, description, source, publish }) =>
    Effect.gen(function* () {
      const request =
        identity._tag === "New"
          ? HttpClientRequest.post(policiesEndpoint(repositoryId)).pipe(
              HttpClientRequest.bodyJson({ name, description, source }),
            )
          : HttpClientRequest.put(policyEndpoint(repositoryId, identity.policyId)).pipe(
              HttpClientRequest.bodyJson({ version: identity.version, name, description, source }),
            )
      const saved = yield* Effect.flatMap(request, HttpClient.execute)
      switch (saved.status) {
        case 200:
        case 201:
          break
        case 409: {
          const conflict = yield* HttpIncomingMessage.schemaBodyJson(
            Schema.Union([PolicyDetail, MessageBody]),
          )(saved)
          return "policy" in conflict
            ? Message.ConflictedSavePolicy({ detail: conflict })
            : Message.RejectedSavePolicy({ message: conflict.message })
        }
        case 422: {
          const { message } = yield* HttpIncomingMessage.schemaBodyJson(MessageBody)(saved)
          return Message.RejectedSavePolicy({ message })
        }
        default:
          return Message.FailedSavePolicy({ reason: `Server answered ${saved.status}` })
      }
      const detail = yield* HttpIncomingMessage.schemaBodyJson(PolicyDetail)(saved)
      if (!publish) return Message.SucceededSavePolicy({ detail, published: false })
      const published = yield* HttpClientRequest.post(
        publishEndpoint(repositoryId, detail.policy.policyId),
      ).pipe(
        HttpClientRequest.bodyJson({ version: detail.policy.version }),
        Effect.flatMap(HttpClient.execute),
      )
      switch (published.status) {
        case 200:
          return Message.SucceededSavePolicy({
            detail: yield* HttpIncomingMessage.schemaBodyJson(PolicyDetail)(published),
            published: true,
          })
        case 422: {
          const { message } = yield* HttpIncomingMessage.schemaBodyJson(MessageBody)(published)
          return Message.RejectedSavePolicy({
            message: `Saved as a draft, not published: ${message}`,
          })
        }
        default:
          return Message.FailedSavePolicy({ reason: `Publish answered ${published.status}` })
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedSavePolicy({ reason: describe(error) })),
      ),
    ),
})

// INIT

export type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  HttpClient.HttpClient
>

export interface InitInput {
  readonly repositoryId: string
  readonly catalog: ReadonlyArray<FactDescription>
  readonly policyNames: ReadonlyArray<string>
  readonly existing: Option.Option<PolicyDetail>
}

const starter: ProgramSource = {
  target: "pull_request",
  matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
}

export const init = ({ repositoryId, catalog, policyNames, existing }: InitInput): Model =>
  Model.make(
    {
      repositoryId,
      identity: Option.match(existing, {
        onNone: () => ({ _tag: "New" as const }),
        onSome: (detail) => ({
          _tag: "Existing" as const,
          policyId: detail.policy.policyId,
          version: detail.policy.version,
        }),
      }),
      name: Option.map(existing, (detail) => detail.policy.name).pipe(Option.getOrElse(() => "")),
      description: Option.map(existing, (detail) => detail.policy.description).pipe(
        Option.getOrElse(() => ""),
      ),
      source: PolicySource.init({
        id: "policy-source",
        source: formatSource(
          Option.map(existing, (detail) => detail.draft).pipe(Option.getOrElse(() => starter)),
        ),
        catalog,
        policyNames: Option.match(existing, {
          onNone: () => policyNames,
          onSome: (detail) => policyNames.filter((name) => name !== detail.policy.name),
        }),
      }),
      validation: { _tag: "NotValidated" },
      submission: { _tag: "NotSubmitted" },
    },
    { disableChecks: true },
  )

// UPDATE

const foldSource = Update.foldChild({
  update: PolicySource.update,
  read: (model: Model) => Option.some(model.source),
  write: (model, nextSource) =>
    evo(model, { source: () => nextSource, validation: () => ({ _tag: "NotValidated" as const }) }),
  toParentMessage: (message) => Message.GotSourceMessage({ message }),
})

const submit = (model: Model, publish: boolean): UpdateReturn =>
  Option.match(parsedSource(model), {
    onNone: () => ({ model }),
    onSome: (source) =>
      isSubmitting(model) || draftIssues(model).length > 0
        ? { model }
        : {
            model: evo(model, { submission: () => ({ _tag: "Submitting" as const, publish }) }),
            commands: [
              SavePolicy({
                repositoryId: model.repositoryId,
                identity: model.identity,
                name: model.name.trim(),
                description: model.description,
                source,
                publish,
              }),
            ],
          },
  })

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedName: ({ value }) => ({
      model: evo(model, {
        name: () => value,
        submission: () => ({ _tag: "NotSubmitted" as const }),
      }),
    }),
    UpdatedDescription: ({ value }) => ({ model: evo(model, { description: () => value }) }),
    GotSourceMessage: ({ message }) => foldSource(model, message),

    ClickedValidate: () =>
      Option.match(parsedSource(model), {
        onNone: () => ({ model }),
        onSome: (source) => ({
          model: evo(model, { validation: () => ({ _tag: "Validating" as const }) }),
          commands: [ValidateDraft({ repositoryId: model.repositoryId, source })],
        }),
      }),
    CompletedValidate: ({ response }) => ({
      model: evo(model, {
        validation: () =>
          response._tag === "Valid"
            ? ({ _tag: "Valid", manifest: response.manifest } as const)
            : ({ _tag: "Invalid", message: response.message } as const),
      }),
    }),
    FailedValidate: ({ reason }) => ({
      model: evo(model, { validation: () => ({ _tag: "Invalid" as const, message: reason }) }),
    }),

    ClickedSave: () => submit(model, false),
    ClickedPublish: () => submit(model, true),

    SucceededSavePolicy: ({ detail, published }) => ({
      model: evo(model, {
        identity: () => ({
          _tag: "Existing" as const,
          policyId: detail.policy.policyId,
          version: detail.policy.version,
        }),
        submission: () => ({ _tag: "NotSubmitted" as const }),
      }),
      outMessage: OutMessage.Saved({ detail, published }),
    }),
    // The draft stays; the base version moves forward so the next save lands on top.
    ConflictedSavePolicy: ({ detail }) => ({
      model: evo(model, {
        identity: () => ({
          _tag: "Existing" as const,
          policyId: detail.policy.policyId,
          version: detail.policy.version,
        }),
        submission: () => ({ _tag: "Conflicted" as const }),
      }),
    }),
    RejectedSavePolicy: ({ message }) => ({
      model: evo(model, { submission: () => ({ _tag: "SubmitError" as const, message }) }),
    }),
    FailedSavePolicy: ({ reason }) => ({
      model: evo(model, { submission: () => ({ _tag: "SubmitError" as const, message: reason }) }),
      outMessage: OutMessage.SaveFailed({ reason }),
    }),
    ClickedCancel: () => ({ model, outMessage: OutMessage.Cancelled() }),
  })

// VIEW

const labelClass = "text-muted-foreground text-xs font-medium"

const validationView = (h: HtmlBuilder<Message>, validation: Validation): Html => {
  switch (validation._tag) {
    case "NotValidated":
      return h.empty
    case "Validating":
      return h.div([h.Class("text-muted-foreground text-xs")], ["Compiling"])
    case "Invalid":
      return h.div([h.Class("text-destructive text-xs"), h.Role("alert")], [validation.message])
    case "Valid":
      return h.div(
        [
          h.Class("text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs"),
          h.DataAttribute("validation", "valid"),
        ],
        [
          h.span([], [`Reads ${validation.manifest.facts.join(", ") || "no facts"}`]),
          h.span([], [`Needs ${validation.manifest.tracks.join(", ") || "no tracks"}`]),
          validation.manifest.references.length === 0
            ? h.empty
            : h.span([], [`References ${validation.manifest.references.length} policies`]),
          h.span([], [`${validation.manifest.nodeCount} nodes`]),
        ],
      )
  }
}

const submissionView = (h: HtmlBuilder<Message>, submission: Submission): Html => {
  switch (submission._tag) {
    case "NotSubmitted":
    case "Submitting":
      return h.empty
    case "Conflicted":
      return h.div(
        [h.Class("text-xs text-amber-600 dark:text-amber-400"), h.Role("alert")],
        [
          "Someone saved this policy meanwhile. Your draft is intact; saving again writes over theirs.",
        ],
      )
    case "SubmitError":
      return h.div([h.Class("text-destructive text-xs"), h.Role("alert")], [submission.message])
  }
}

export const view = Submodel.defineView<Model, Message>((model, h): Html => {
  const issues = draftIssues(model)
  const busy = isSubmitting(model)
  const canSubmit = issues.length === 0 && !busy
  return h.div(
    [h.Class("flex flex-col gap-4"), h.DataAttribute("editor", "policy")],
    [
      h.div(
        [h.Class("flex flex-wrap items-end justify-between gap-3")],
        [
          h.h2(
            [h.Class("text-sm font-semibold tracking-tight")],
            [model.identity._tag === "New" ? "New policy" : "Edit policy"],
          ),
          h.div(
            [h.Class("flex items-center gap-2")],
            [
              Button.view(h, {
                variant: "outline",
                size: "sm",
                onClick: Message.ClickedCancel(),
                isDisabled: busy,
                label: "Cancel",
              }),
              Button.view(h, {
                variant: "outline",
                size: "sm",
                onClick: Message.ClickedValidate(),
                isDisabled: Option.isNone(parsedSource(model)),
                label: "Validate",
              }),
              Button.view(h, {
                variant: "secondary",
                size: "sm",
                onClick: Message.ClickedSave(),
                isDisabled: !canSubmit,
                label: "Save draft",
              }),
              Button.view(
                h,
                {
                  size: "sm",
                  onClick: Message.ClickedPublish(),
                  isDisabled: !canSubmit,
                  label: busy ? "Working" : "Publish",
                },
                [h.DataAttribute("action", "publish")],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("grid gap-3 sm:grid-cols-[1fr_2fr]")],
        [
          input(h, {
            id: "policy-name",
            label: "Name",
            value: model.name,
            placeholder: "Ready for review",
            onInput: (value) => Message.UpdatedName({ value }),
            labelClass,
            wrapperClass: "gap-1",
          }),
          input(h, {
            id: "policy-description",
            label: "Description",
            value: model.description,
            placeholder: "What this policy decides",
            onInput: (value) => Message.UpdatedDescription({ value }),
            labelClass,
            wrapperClass: "gap-1",
            className: cn(inputClass),
          }),
        ],
      ),
      h.div(
        [h.Class("flex flex-col gap-1")],
        [
          h.span([h.Class(labelClass)], ["Program"]),
          h.submodel({
            slotId: "policy-source",
            model: model.source,
            view: PolicySource.view,
            toParentMessage: (message) => Message.GotSourceMessage({ message }),
          }),
          h.div(
            [h.Class("text-muted-foreground text-xs")],
            [
              "Keys: target, appliesWhen, matchesWhen. Conditions: all, any, not, { fact, operator, value }, { some | every | none, where }, { policy }.",
            ],
          ),
        ],
      ),
      issues.length === 0
        ? h.empty
        : h.ul(
            [h.Class("text-destructive flex flex-col gap-0.5 text-xs"), h.Role("alert")],
            issues.map((issue) => h.li([], [issue])),
          ),
      validationView(h, model.validation),
      submissionView(h, model.submission),
    ],
  )
})
