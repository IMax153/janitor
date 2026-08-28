import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const Id = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const Name = Schema.NonEmptyString
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i))

const Repository = Schema.Struct({
  id: Id,
  full_name: Name,
})

const Sender = Schema.Struct({
  id: Id,
  login: Name,
})

export const DeliveryId = Schema.NonEmptyString

export const PushPayload = Schema.Struct({
  repository: Repository,
  sender: Sender,
  ref: Name,
  before: Sha,
  after: Sha,
  forced: Schema.Boolean,
})

export const PullRequestPayload = Schema.Struct({
  action: Name,
  number: Id,
  repository: Repository,
  sender: Sender,
  pull_request: Schema.Struct({
    id: Id,
    head: Schema.Struct({ sha: Sha }),
    base: Schema.Struct({ sha: Sha }),
    draft: Schema.Boolean,
    merged: Schema.Boolean,
  }),
})

export type WebhookMessage =
  | {
      readonly version: 1
      readonly event: "push"
      readonly deliveryId: string
      readonly repository: { readonly id: number; readonly fullName: string }
      readonly sender: { readonly id: number; readonly login: string }
      readonly ref: string
      readonly before: string
      readonly after: string
      readonly forced: boolean
    }
  | {
      readonly version: 1
      readonly event: "pull_request"
      readonly deliveryId: string
      readonly repository: { readonly id: number; readonly fullName: string }
      readonly sender: { readonly id: number; readonly login: string }
      readonly action: string
      readonly number: number
      readonly pullRequest: {
        readonly id: number
        readonly headSha: string
        readonly baseSha: string
        readonly draft: boolean
        readonly merged: boolean
      }
    }

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const decodePush = Schema.decodeUnknownEffect(PushPayload)
const decodePullRequest = Schema.decodeUnknownEffect(PullRequestPayload)

export const parseJson = (text: string) => decodeJson(text)

export const normalizePush = Effect.fn("Webhook.normalizePush")(function* (
  deliveryId: string,
  input: unknown,
) {
  const payload = yield* decodePush(input)
  return {
    version: 1,
    event: "push",
    deliveryId,
    repository: {
      id: payload.repository.id,
      fullName: payload.repository.full_name,
    },
    sender: payload.sender,
    ref: payload.ref,
    before: payload.before,
    after: payload.after,
    forced: payload.forced,
  } satisfies WebhookMessage
})

export const normalizePullRequest = Effect.fn("Webhook.normalizePullRequest")(function* (
  deliveryId: string,
  input: unknown,
) {
  const payload = yield* decodePullRequest(input)
  return {
    version: 1,
    event: "pull_request",
    deliveryId,
    repository: {
      id: payload.repository.id,
      fullName: payload.repository.full_name,
    },
    sender: payload.sender,
    action: payload.action,
    number: payload.number,
    pullRequest: {
      id: payload.pull_request.id,
      headSha: payload.pull_request.head.sha,
      baseSha: payload.pull_request.base.sha,
      draft: payload.pull_request.draft,
      merged: payload.pull_request.merged,
    },
  } satisfies WebhookMessage
})
