import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { GitHubWebHookLayer } from "./GitHub/Http.ts"
import { RateLimitMiddlewareLayer } from "./Middleware.ts"

const ApiRouterLayer = Layer.effect(
  HttpRouter.HttpRouter,
  Effect.map(HttpRouter.HttpRouter, (router) => router.prefixed("/api/v1")),
)

export const RoutesLayer = GitHubWebHookLayer.pipe(
  Layer.provide(RateLimitMiddlewareLayer),
  Layer.provide(ApiRouterLayer),
)
