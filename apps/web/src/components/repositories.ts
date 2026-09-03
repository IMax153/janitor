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
export const configurationEndpoint = (repositoryId: string) =>
  `${REPOSITORIES_ENDPOINT}/${encodeURIComponent(repositoryId)}/configuration`
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

export const PolicyRecord = Schema.Struct({
  policyId: Schema.String,
  repositoryId: Schema.String,
  name: Schema.String,
  target: Schema.Literals(["issue", "pull_request"]),
  description: Schema.String,
  publishedVersionId: Schema.NullOr(Schema.String),
  publishedRevision: Schema.NullOr(Schema.Int),
  version: Schema.Int,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
})
export type PolicyRecord = typeof PolicyRecord.Type

export const RuleRecord = Schema.Struct({
  id: Schema.String,
  repositoryId: Schema.String,
  labelId: Schema.String,
  policyId: Schema.String,
  onNoMatch: Schema.Literals(["ensure-absent", "preserve"]),
  group: Schema.NullOr(Schema.String),
  priority: Schema.Int,
  enabled: Schema.Boolean,
  labelStatus: Schema.Literals(["valid", "missing"]),
  version: Schema.Int,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
})
export type RuleRecord = typeof RuleRecord.Type

export const Plan = Schema.Struct({
  rules: Schema.Array(
    Schema.Struct({
      ruleId: Schema.String,
      outcome: Schema.Literals(["match", "no-match", "unknown", "not-applicable"]),
      selected: Schema.Boolean,
    }),
  ),
  actions: Schema.Array(
    Schema.Struct({
      labelId: Schema.String,
      action: Schema.Literals(["add", "remove"]),
      ruleId: Schema.String,
    }),
  ),
})
export type Plan = typeof Plan.Type

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

export const ConfigurationView = Schema.Struct({
  repositoryId: Schema.String,
  configuredRevision: Schema.Int,
  activeRevision: Schema.NullOr(Schema.Int),
  pendingTracks: Schema.Array(Schema.String),
  policies: Schema.Array(PolicyRecord),
  rules: Schema.Array(RuleRecord),
  labels: Schema.Array(SynchronizedLabel),
  labelFreshness: SyncFreshness,
})
export type ConfigurationView = typeof ConfigurationView.Type

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
  plan: Schema.NullOr(Plan),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
})
export type ReconciliationRecord = typeof ReconciliationRecord.Type

export const RepositoryDetail = Schema.Struct({
  configuration: ConfigurationView,
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
        configuration: getJson(configurationEndpoint(repositoryId), ConfigurationView),
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

/** One line per planned change, with label IDs resolved to names. */
export const describePlan = (
  plan: Plan,
  labels: ReadonlyArray<SynchronizedLabel>,
  rules: ReadonlyArray<RuleRecord>,
  policies: ReadonlyArray<PolicyRecord>,
): ReadonlyArray<string> => {
  const name = (labelId: string) =>
    labels.find((label) => label.labelId === labelId)?.name ?? labelId
  const via = (ruleId: string) => {
    const rule = rules.find((candidate) => candidate.id === ruleId)
    const policy = policies.find((candidate) => candidate.policyId === rule?.policyId)
    return policy?.name ?? ruleId
  }
  return plan.actions.map(
    (action) => `${action.action} ${name(action.labelId)} (${via(action.ruleId)})`,
  )
}

/** One line of status for the configured revision. */
export const describeRevision = (view: ConfigurationView): string => {
  if (view.configuredRevision === 0) return "Nothing configured"
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

const policiesSection = (h: HtmlBuilder<Message>, view: ConfigurationView): Html =>
  h.section(
    [h.Class("flex flex-col gap-2")],
    [
      sectionTitle(h, "Policies"),
      h.div([h.Class("text-muted-foreground text-sm")], [describeRevision(view)]),
      view.policies.length === 0
        ? h.div([h.Class("text-muted-foreground text-sm")], ["No policies yet"])
        : h.ul(
            [h.Class("flex flex-col gap-2")],
            view.policies.map((policy) =>
              h.li(
                [h.Class("flex items-center justify-between gap-2 rounded-md border p-3 text-sm")],
                [
                  h.div(
                    [h.Class("flex flex-col")],
                    [
                      h.span([h.Class("font-medium")], [policy.name]),
                      h.span(
                        [h.Class("text-muted-foreground text-xs")],
                        [policy.target === "pull_request" ? "Pull requests" : "Issues"],
                      ),
                    ],
                  ),
                  h.span(
                    [h.Class(cn(badgeClass, policy.publishedRevision === null && "opacity-60"))],
                    [
                      policy.publishedRevision === null
                        ? "draft"
                        : `published v${policy.publishedRevision}`,
                    ],
                  ),
                ],
              ),
            ),
          ),
    ],
  )

const rulesSection = (h: HtmlBuilder<Message>, view: ConfigurationView): Html =>
  h.section(
    [h.Class("flex flex-col gap-2")],
    [
      sectionTitle(h, "Rules"),
      view.rules.length === 0
        ? h.div([h.Class("text-muted-foreground text-sm")], ["No rules yet"])
        : h.ul(
            [h.Class("flex flex-col gap-2")],
            view.rules.map((rule) => {
              const label = view.labels.find((candidate) => candidate.labelId === rule.labelId)
              const policy = view.policies.find((candidate) => candidate.policyId === rule.policyId)
              return h.li(
                [
                  h.Class(
                    cn(
                      "flex items-center justify-between gap-2 rounded-md border p-3 text-sm",
                      !rule.enabled && "opacity-60",
                    ),
                  ),
                ],
                [
                  h.div(
                    [h.Class("flex items-center gap-2")],
                    [
                      h.span([h.Class(badgeClass)], [label?.name ?? rule.labelId]),
                      h.span([h.Class("text-muted-foreground")], ["when"]),
                      h.span([h.Class("font-medium")], [policy?.name ?? rule.policyId]),
                    ],
                  ),
                  h.div(
                    [h.Class("text-muted-foreground text-xs")],
                    [
                      [
                        rule.onNoMatch === "ensure-absent" ? "removed on miss" : "kept on miss",
                        rule.group === null ? "" : `group ${rule.group} priority ${rule.priority}`,
                        rule.enabled ? "" : "disabled",
                      ]
                        .filter((part) => part.length > 0)
                        .join(" · "),
                    ],
                  ),
                ],
              )
            }),
          ),
    ],
  )

const labelsSection = (h: HtmlBuilder<Message>, view: ConfigurationView): Html =>
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

const planCell = (
  h: HtmlBuilder<Message>,
  row: ReconciliationRecord,
  view: ConfigurationView,
): Html => {
  if (row.plan === null) return h.span([h.Class("text-muted-foreground")], [""])
  const lines = describePlan(row.plan, view.labels, view.rules, view.policies)
  return lines.length === 0
    ? h.span([h.Class("text-muted-foreground")], ["no changes"])
    : h.ul(
        [h.Class("flex flex-col gap-0.5")],
        lines.map((line, index) =>
          h.li([h.DataAttribute("action", row.plan?.actions[index]?.action ?? "")], [line]),
        ),
      )
}

const reconciliationsSection = (
  h: HtmlBuilder<Message>,
  reconciliations: ReadonlyArray<ReconciliationRecord>,
  view: ConfigurationView,
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
                    ["#", "Snapshot", "Revision", "Outcome", "Plan", "Detail", "When"].map((head) =>
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
                      h.td([h.Class("py-1 pr-3")], [planCell(h, row, view)]),
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
              policiesSection(h, detail.configuration),
              rulesSection(h, detail.configuration),
              labelsSection(h, detail.configuration),
              reconciliationsSection(h, detail.reconciliations, detail.configuration),
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
