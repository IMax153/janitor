import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { type IngressSecrets, makeGitHubWebHookRoutesLayer } from "./GitHubWebhook.ts"
import { RateLimitMiddlewareLayer } from "./Middleware.ts"
import { SyncRoutesLayer } from "./Sync.ts"

const ApiRouterLayer = Layer.effect(
  HttpRouter.HttpRouter,
  Effect.map(HttpRouter.HttpRouter, (router) => router.prefixed("/api/v1")),
)

export const makeRoutesLayer = (secrets: IngressSecrets) =>
  Layer.mergeAll(makeGitHubWebHookRoutesLayer(secrets), SyncRoutesLayer).pipe(
    Layer.provide(RateLimitMiddlewareLayer),
    Layer.provide(ApiRouterLayer),
  )
