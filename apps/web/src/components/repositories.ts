import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as FoldkitCommand from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import * as Subscription from "foldkit/subscription"
import * as Update from "foldkit/update"
import { cn } from "@/lib/utils"

// CONSTANTS

export const REPOSITORIES_ENDPOINT = "/api/v1/repositories"
export const rulesEndpoint = (repositoryId: string) =>
  `${REPOSITORIES_ENDPOINT}/${encodeURIComponent(repositoryId)}/rules`
export const reconciliationsEndpoint = (repositoryId: string) =>
  `${REPOSITORIES_ENDPOINT}/${encodeURIComponent(repositoryId)}/reconciliations`

/** How often the selected repository is refreshed while the page is open. */
export const POLL_INTERVAL = Duration.seconds(10)

// WIRE SCHEMA
//
// Mirrors `@janitor/domain/Labeling/*`. See sync-button.ts for why the
// schemas are copied rather than imported.

export const RepositoryOverview = Schema.Struct({
  repositoryId: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  enabled: Schema.Boolean,
  access: Schema.Literals(["accessible", "suspect", "lost"]),
  configuredRevision: Schema.NullOr(Schema.Int),
  activeRevision: Schema.NullOr(Schema.Int),
})
export type RepositoryOverview = typeof RepositoryOverview.Type

export const ConcretePredicate = Schema.Union([
  Schema.TaggedStruct("TitleContains", { value: Schema.String, caseSensitive: Schema.Boolean }),
  Schema.TaggedStruct("AuthorIs", { login: Schema.String }),
  Schema.TaggedStruct("BaseBranchIs", { ref: Schema.String }),
  Schema.TaggedStruct("DraftStateIs", { draft: Schema.Boolean }),
])
export type ConcretePredicate = typeof ConcretePredicate.Type

export const Rule = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  target: Schema.Literals(["issue", "pull_request"]),
  evaluator: Schema.TaggedStruct("Concrete", { predicates: Schema.Array(ConcretePredicate) }),
  labels: Schema.Array(Schema.String),
})
export type Rule = typeof Rule.Type

export const SynchronizedLabel = Schema.Struct({
  labelId: Schema.String,
  name: Schema.String,
  availability: Schema.Literals(["available", "suspect", "unavailable"]),
})
export type SynchronizedLabel = typeof SynchronizedLabel.Type

export const SyncFreshness = Schema.Literals([
  "projected",
  "verified",
  "syncing",
  "stale",
  "blocked",
])

export const RulesetView = Schema.Struct({
  repositoryId: Schema.String,
  configuredRevision: Schema.Int,
  configured: Schema.Struct({ rules: Schema.Array(Rule) }),
  activeRevision: Schema.NullOr(Schema.Int),
  pendingTracks: Schema.Array(Schema.String),
  labels: Schema.Array(SynchronizedLabel),
  labelFreshness: SyncFreshness,
})
export type RulesetView = typeof RulesetView.Type

export const ReconciliationRecord = Schema.Struct({
  repositoryId: Schema.String,
  number: Schema.Int,
  snapshotGeneration: Schema.String,
  rulesRevision: Schema.Int,
  coveredSequence: Schema.String,
  fingerprint: Schema.String,
  createdAt: Schema.DateTimeUtc,
  outcome: Schema.NullOr(Schema.Literals(["evaluated", "superseded", "not-qualified", "failed"])),
  detail: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
})
export type ReconciliationRecord = typeof ReconciliationRecord.Type

export const RepositoryDetail = Schema.Struct({
  rules: RulesetView,
  reconciliations: Schema.Array(ReconciliationRecord),
})
export type RepositoryDetail = typeof RepositoryDetail.Type

// MODEL

export const Model = Schema.Struct({
  repositories: Schema.Option(Schema.Array(RepositoryOverview)),
  repositoriesError: Schema.Option(Schema.String),
  selected: Schema.Option(Schema.String),
  detail: Schema.Option(RepositoryDetail),
  detailError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  GotRepositories: { repositories: Schema.Array(RepositoryOverview) },
  FailedRepositories: { reason: Schema.String },
  Selected: { repositoryId: Schema.String },
  Polled: {},
  GotDetail: { repositoryId: Schema.String, detail: RepositoryDetail },
  FailedDetail: { repositoryId: Schema.String, reason: Schema.String },
})
export type Message = typeof Message.Type

// COMMANDS

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error)

const getJson = <A, RD>(url: string, schema: Schema.ConstraintDecoder<A, RD>) =>
  HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpIncomingMessage.schemaBodyJson(schema)),
  )

export const FetchRepositories = FoldkitCommand.define("FetchRepositories", {
  messages: [Message.GotRepositories, Message.FailedRepositories],
  execute: getJson(REPOSITORIES_ENDPOINT, Schema.Array(RepositoryOverview)).pipe(
    Effect.map((repositories) => Message.GotRepositories({ repositories })),
    Effect.catch((error) =>
      Effect.succeed(Message.FailedRepositories({ reason: describe(error) })),
    ),
  ),
})

export const FetchDetail = FoldkitCommand.define("FetchDetail", {
  args: { repositoryId: Schema.String },
  messages: [Message.GotDetail, Message.FailedDetail],
  execute: ({ repositoryId }) =>
    Effect.all(
      {
        rules: getJson(rulesEndpoint(repositoryId), RulesetView),
        reconciliations: getJson(
          reconciliationsEndpoint(repositoryId),
          Schema.Array(ReconciliationRecord),
        ),
      },
      { concurrency: 2 },
    ).pipe(
      Effect.map((detail) => Message.GotDetail({ repositoryId, detail })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedDetail({ repositoryId, reason: describe(error) })),
      ),
    ),
})

// INIT

export type UpdateReturn = Update.Return<Model, Message, HttpClient.HttpClient>

export const init = (): UpdateReturn => ({
  model: Model.make(
    {
      repositories: Option.none(),
      repositoriesError: Option.none(),
      selected: Option.none(),
      detail: Option.none(),
      detailError: Option.none(),
    },
    { disableChecks: true },
  ),
  commands: [FetchRepositories()],
})

// UPDATE

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotRepositories: ({ repositories }) => {
      const next = evo(model, {
        repositories: () => Option.some(repositories),
        repositoriesError: () => Option.none<string>(),
      })
      // Open the first repository so the page is never empty.
      const first = repositories[0]
      return Option.isNone(model.selected) && first !== undefined
        ? {
            model: evo(next, { selected: () => Option.some(first.repositoryId) }),
            commands: [FetchDetail({ repositoryId: first.repositoryId })],
          }
        : { model: next }
    },

    FailedRepositories: ({ reason }) => ({
      model: evo(model, { repositoriesError: () => Option.some(reason) }),
    }),

    Selected: ({ repositoryId }) =>
      Option.contains(model.selected, repositoryId)
        ? { model }
        : {
            model: evo(model, {
              selected: () => Option.some(repositoryId),
              detail: () => Option.none<RepositoryDetail>(),
              detailError: () => Option.none<string>(),
            }),
            commands: [FetchDetail({ repositoryId })],
          },

    Polled: () =>
      Option.match(model.selected, {
        onNone: () => ({ model }),
        onSome: (repositoryId) => ({ model, commands: [FetchDetail({ repositoryId })] }),
      }),

    // A late answer for a repository that is no longer selected is dropped.
    GotDetail: ({ repositoryId, detail }) =>
      Option.contains(model.selected, repositoryId)
        ? {
            model: evo(model, {
              detail: () => Option.some(detail),
              detailError: () => Option.none<string>(),
            }),
          }
        : { model },

    FailedDetail: ({ repositoryId, reason }) =>
      Option.contains(model.selected, repositoryId)
        ? { model: evo(model, { detailError: () => Option.some(reason) }) }
        : { model },
  })

// SUBSCRIPTIONS

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  repositoryPoll: entry(
    { hasSelection: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ hasSelection: Option.isSome(model.selected) }),
      dependenciesToStream: ({ hasSelection }) =>
        hasSelection
          ? Stream.map(Stream.tick(POLL_INTERVAL), () => Message.Polled())
          : Stream.empty,
    },
  ),
}))

// VIEW

export const describePredicate = (predicate: ConcretePredicate): string => {
  switch (predicate._tag) {
    case "TitleContains":
      return `title contains "${predicate.value}"${predicate.caseSensitive ? " (case sensitive)" : ""}`
    case "AuthorIs":
      return `author is ${predicate.login}`
    case "BaseBranchIs":
      return `base branch is ${predicate.ref}`
    case "DraftStateIs":
      return predicate.draft ? "is a draft" : "is not a draft"
  }
}

/** One line of status for the configured revision. */
export const describeRevision = (view: RulesetView): string => {
  if (view.configuredRevision === 0) return "No rules saved"
  if (view.activeRevision === view.configuredRevision) {
    return `Revision ${view.configuredRevision} active`
  }
  const waiting = view.pendingTracks.length === 0 ? "promotion" : view.pendingTracks.join(", ")
  return `Revision ${view.configuredRevision} waiting on ${waiting}`
}

const badgeClass = "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium"

const sectionTitle = <M>(h: HtmlBuilder<M>, text: string): Html =>
  h.h2([h.Class("text-sm font-semibold tracking-tight")], [text])

const repositoryList = (h: HtmlBuilder<Message>, model: Model): Html =>
  Option.match(model.repositories, {
    onNone: () =>
      h.div(
        [h.Class("text-muted-foreground text-sm")],
        [Option.getOrElse(model.repositoriesError, () => "Loading repositories")],
      ),
    onSome: (repositories) =>
      repositories.length === 0
        ? h.div([h.Class("text-muted-foreground text-sm")], ["No repositories synchronized yet"])
        : h.ul(
            [h.Class("flex flex-col gap-1")],
            repositories.map((repository) =>
              h.li(
                [],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.DataAttribute("repository-id", repository.repositoryId),
                      h.DataAttribute(
                        "state",
                        Option.contains(model.selected, repository.repositoryId)
                          ? "selected"
                          : "idle",
                      ),
                      h.OnClick(Message.Selected({ repositoryId: repository.repositoryId })),
                      h.Class(
                        cn(
                          "flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                          Option.contains(model.selected, repository.repositoryId) &&
                            "bg-accent font-medium",
                        ),
                      ),
                    ],
                    [
                      h.span([h.Class("truncate")], [`${repository.owner}/${repository.repo}`]),
                      h.span(
                        [h.Class("text-muted-foreground text-xs")],
                        [repository.enabled ? "enabled" : "paused"],
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
  })

const rulesSection = (h: HtmlBuilder<Message>, view: RulesetView): Html =>
  h.section(
    [h.Class("flex flex-col gap-2")],
    [
      sectionTitle(h, "Rules"),
      h.div([h.Class("text-muted-foreground text-sm")], [describeRevision(view)]),
      view.configured.rules.length === 0
        ? h.empty
        : h.ul(
            [h.Class("flex flex-col gap-2")],
            view.configured.rules.map((rule) =>
              h.li(
                [h.Class("rounded-md border p-3 text-sm")],
                [
                  h.div(
                    [h.Class("flex items-center justify-between gap-2")],
                    [
                      h.span([h.Class("font-medium")], [rule.name]),
                      h.span(
                        [h.Class(cn(badgeClass, !rule.enabled && "opacity-60"))],
                        [rule.enabled ? "enabled" : "disabled"],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("text-muted-foreground mt-1")],
                    [
                      `${rule.target === "pull_request" ? "Pull requests" : "Issues"} where ${rule.evaluator.predicates
                        .map(describePredicate)
                        .join(" and ")}`,
                    ],
                  ),
                  h.div(
                    [h.Class("mt-2 flex flex-wrap gap-1")],
                    rule.labels.map((labelId) =>
                      h.span(
                        [h.Class(badgeClass)],
                        [view.labels.find((label) => label.labelId === labelId)?.name ?? labelId],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
    ],
  )

const labelsSection = (h: HtmlBuilder<Message>, view: RulesetView): Html =>
  h.section(
    [h.Class("flex flex-col gap-2")],
    [
      sectionTitle(h, `Labels (${view.labelFreshness})`),
      view.labels.length === 0
        ? h.div([h.Class("text-muted-foreground text-sm")], ["No labels synchronized"])
        : h.div(
            [h.Class("flex flex-wrap gap-1")],
            view.labels.map((label) =>
              h.span(
                [
                  h.Class(
                    cn(badgeClass, label.availability !== "available" && "line-through opacity-60"),
                  ),
                  h.Title(label.availability),
                ],
                [label.name],
              ),
            ),
          ),
    ],
  )

const reconciliationsSection = (
  h: HtmlBuilder<Message>,
  reconciliations: ReadonlyArray<ReconciliationRecord>,
): Html =>
  h.section(
    [h.Class("flex flex-col gap-2")],
    [
      sectionTitle(h, "Reconciliations"),
      reconciliations.length === 0
        ? h.div(
            [h.Class("text-muted-foreground text-sm")],
            [
              "No qualified snapshots yet. Activate a revision and change an issue or pull request.",
            ],
          )
        : h.table(
            [h.Class("w-full text-sm")],
            [
              h.thead(
                [h.Class("text-muted-foreground text-left text-xs")],
                [
                  h.tr(
                    [],
                    ["#", "Snapshot", "Revision", "Outcome", "Detail", "When"].map((head) =>
                      h.th([h.Class("py-1 pr-3 font-medium")], [head]),
                    ),
                  ),
                ],
              ),
              h.tbody(
                [],
                reconciliations.map((row) =>
                  h.tr(
                    [h.Class("border-t"), h.DataAttribute("outcome", row.outcome ?? "pending")],
                    [
                      h.td([h.Class("py-1 pr-3")], [String(row.number)]),
                      h.td([h.Class("py-1 pr-3")], [row.snapshotGeneration]),
                      h.td([h.Class("py-1 pr-3")], [String(row.rulesRevision)]),
                      h.td([h.Class("py-1 pr-3")], [row.outcome ?? "pending"]),
                      h.td([h.Class("text-muted-foreground py-1 pr-3")], [row.detail ?? ""]),
                      h.td(
                        [h.Class("text-muted-foreground py-1 pr-3 whitespace-nowrap")],
                        [DateTime.formatUtc(row.completedAt ?? row.createdAt)],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
    ],
  )

const detailPanel = (h: HtmlBuilder<Message>, model: Model): Html =>
  Option.match(model.selected, {
    onNone: () => h.div([h.Class("text-muted-foreground text-sm")], ["Select a repository"]),
    onSome: () =>
      Option.match(model.detail, {
        onNone: () =>
          h.div(
            [h.Class("text-muted-foreground text-sm")],
            [Option.getOrElse(model.detailError, () => "Loading")],
          ),
        onSome: (detail) =>
          h.div(
            [h.Class("flex flex-col gap-6")],
            [
              Option.match(model.detailError, {
                onNone: () => h.empty,
                onSome: (reason) =>
                  h.div([h.Class("text-destructive text-sm")], [`Refresh failed: ${reason}`]),
              }),
              rulesSection(h, detail.rules),
              labelsSection(h, detail.rules),
              reconciliationsSection(h, detail.reconciliations),
            ],
          ),
      }),
  })

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [h.Class("grid gap-6 p-4 lg:grid-cols-[16rem_1fr] lg:p-6")],
    [
      h.aside(
        [h.Class("flex flex-col gap-2")],
        [sectionTitle(h, "Repositories"), repositoryList(h, model)],
      ),
      h.div([], [detailPanel(h, model)]),
    ],
  ),
)
