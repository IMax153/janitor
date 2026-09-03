import * as AlchemyCloudflareCluster from "@effect/platform-cloudflare/AlchemyCloudflareCluster"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Postgres from "alchemy/SQL/Postgres"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as Path from "effect/Path"
import * as Etag from "effect/unstable/http/Etag"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { GitHubEventsDeadLetterQueue, GitHubEventsQueue } from "./GitHub/EventQueue.ts"
import { GitHubWebhookPayloadsBucket } from "./GitHub/PayloadStore.ts"
import { ingressSecrets } from "./Ingress/GitHubWebhook.ts"
import { makeRoutesLayer } from "./Ingress/Routes.ts"
import * as Config from "effect/Config"
import * as PayloadCipher from "./PayloadCipher.ts"
import * as Cause from "effect/Cause"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { JanitorHyperdrive } from "./Database.ts"
import {
  GitHubEventsDeadLetter,
  GitHubPayloadReader,
  handleMessage,
} from "./GitHub/WebhookConsumer.ts"
import * as GitHubAppAuth from "./GitHub/AppAuth.ts"
import { GitHubBudget } from "./GitHub/RateBudget.ts"
import { GitHubHttpCache } from "./GitHub/HttpCache.ts"
import { GitHubReadModel } from "./GitHub/ReadModel.ts"
import { GitHubTransport } from "./GitHub/Transport.ts"
import {
  SyncInstallationInventoryLayer,
  SyncInstallationInventoryRegistration,
} from "./GitHub/SyncInstallationInventory.ts"
import { RefreshEntityLayer, RefreshEntityRegistration } from "./GitHub/RefreshEntity.ts"
import {
  SyncRepositoryTrackLayer,
  SyncRepositoryTrackRegistration,
} from "./GitHub/SyncRepositoryTrack.ts"
import { ContentPurge } from "./ContentPurge.ts"
import { SyncPlanner } from "./SyncPlanner.ts"
import { SyncRepairCronLayer, SyncRepairCronName } from "./SyncRepairCron.ts"
import { SyncStatus } from "./SyncStatus.ts"
import { SyncTargets } from "./SyncTargets.ts"
import { GitHubWebhookJournal } from "./GitHub/WebhookJournal.ts"
import {
  ProjectGitHubWebhookLayer,
  ProjectGitHubWebhookRegistration,
} from "./GitHub/ProjectWebhook.ts"
import { WorkflowDispatcher } from "./WorkflowDispatcher.ts"
import { WorkflowOutbox } from "./WorkflowOutbox.ts"
import { WorkflowOutboxCronLayer, WorkflowOutboxCronName } from "./WorkflowOutboxCron.ts"

/** The Zero Trust organization whose GitHub identity provider admits people. */
const ACCESS_TEAM_DOMAIN = "effectful.cloudflareaccess.com"
const ACCESS_GITHUB_IDENTITY_PROVIDER_ID = "0d007daa-be1b-4e31-b538-98a8048f6863"
const ACCESS_GITHUB_ORGANIZATION = "Effectful-Tech"
const DOMAIN = "janitor.effectful.co"

export default class ClusterWorker extends Cloudflare.Worker<ClusterWorker>()(
  "ClusterWorker",
  Effect.gen(function* () {
    // Spike policy: any member of the organization. The split into a
    // configuration team and a stricter operator team comes later.
    const access = yield* Cloudflare.Access.Application("Access", {
      type: "self_hosted",
      name: "Janitor",
      sessionDuration: "8h",
      allowedIdps: [ACCESS_GITHUB_IDENTITY_PROVIDER_ID],
      autoRedirectToIdentity: true,
      policies: [
        {
          name: `${ACCESS_GITHUB_ORGANIZATION} members`,
          decision: "allow",
          include: [
            {
              githubOrganization: {
                identityProviderId: ACCESS_GITHUB_IDENTITY_PROVIDER_ID,
                name: ACCESS_GITHUB_ORGANIZATION,
              },
            },
          ],
        },
      ],
    })
    // GitHub cannot log in. A hostname-level application beats the Worker
    // level one, so this path skips Access and keeps its signature check.
    yield* Cloudflare.Access.Application("WebhookBypass", {
      type: "self_hosted",
      name: "Janitor GitHub webhooks",
      domain: `${DOMAIN}/api/v1/webhooks/github`,
      appLauncherVisible: false,
      policies: [{ name: "GitHub deliveries", decision: "bypass", include: ["everyone"] }],
    })

    // The web app is served from this Worker so the browser and the API share
    // one origin: no CORS, and the Access cookie covers both once it exists.
    const web = yield* Command.Build("WebBuild", {
      command: "./node_modules/.bin/vp build",
      cwd: "apps/web",
      outdir: "dist",
    })
    return {
      main: import.meta.url,
      compatibility: { flags: ["nodejs_compat"] },
      domain: DOMAIN,
      // The custom domain is the only entry; Access covers it.
      workersDev: false,
      access,
      // Read at init from the environment: the plan-phase Config interceptor
      // only binds values it can resolve from the deploy environment.
      env: { ACCESS_AUD: access.aud },
      assets: {
        directory: web.outdir,
        // Foldkit routes on the client; unmatched paths boot the app.
        notFoundHandling: "single-page-application" as const,
      },
    }
  }),
  Effect.gen(function* () {
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(JanitorHyperdrive)

    const githubEventsQueue = yield* GitHubEventsQueue
    const githubDeadLetterQueue = yield* Cloudflare.Queues.WriteQueue(
      yield* GitHubEventsDeadLetterQueue,
    )
    const githubPayloadsBucket = yield* Cloudflare.R2.ReadWriteBucket(
      yield* GitHubWebhookPayloadsBucket,
    )

    const DatabaseLayer = Postgres.PostgresLayer({
      url: hyperdrive.connectionString,
    })

    // Every secret is read here, during init, so Alchemy binds it at deploy
    // time. The cluster layer is built lazily and cannot register bindings.
    const secrets = yield* Config.unwrap(ingressSecrets)
    const appCredentials = yield* Config.unwrap(
      GitHubAppAuth.config({ appId: "GITHUB_APP_ID", privateKey: "GITHUB_APP_PRIVATE_KEY" }),
    )
    const GitHubPayloadCipherLayer = PayloadCipher.layerFrom(secrets.cipher)

    const GitHubTransportLayer = GitHubTransport.layer.pipe(
      Layer.provideMerge(GitHubAppAuth.layerFrom(appCredentials)),
      Layer.provideMerge(GitHubBudget.layer),
      Layer.provide(FetchHttpClient.layer),
    )

    const ClusterLayer = Layer.mergeAll(
      ProjectGitHubWebhookLayer,
      SyncInstallationInventoryLayer,
      SyncRepositoryTrackLayer,
      RefreshEntityLayer,
      WorkflowOutboxCronLayer,
      SyncRepairCronLayer,
    ).pipe(
      Layer.provideMerge(Layer.mergeAll(SyncPlanner.layer, SyncStatus.layer)),
      Layer.provideMerge(
        WorkflowDispatcher.layer([
          ProjectGitHubWebhookRegistration,
          SyncInstallationInventoryRegistration,
          SyncRepositoryTrackRegistration,
          RefreshEntityRegistration,
        ]),
      ),
      Layer.provideMerge(GitHubTransportLayer),
      Layer.provideMerge(
        Layer.mergeAll(
          GitHubWebhookJournal.layer,
          GitHubReadModel.layer,
          SyncTargets.layer,
          ContentPurge.layer,
          GitHubHttpCache.layer.pipe(Layer.provide(GitHubPayloadCipherLayer)),
          GitHubPayloadReader.fromBucket(githubPayloadsBucket),
          GitHubEventsDeadLetter.fromQueue(githubDeadLetterQueue),
          GitHubPayloadCipherLayer,
        ),
      ),
      Layer.provideMerge(WorkflowOutbox.layer),
      Layer.provide(DatabaseLayer),
    )

    const cluster = yield* AlchemyCloudflareCluster.make({
      entities: [],
      layer: ClusterLayer,
    })
    const wakeOutboxDispatch = cluster.wake(WorkflowOutboxCronName)
    const wakeSyncRepair = cluster.wake(SyncRepairCronName)
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      Effect.all([wakeOutboxDispatch(), wakeSyncRepair()], { discard: true }),
    )

    yield* Cloudflare.Queues.consumeQueueMessages(
      githubEventsQueue,
      { batchSize: 10, maxRetries: 10, retryDelay: "1 minute" },
      (messages) =>
        cluster.provide(
          Stream.runForEach(messages, (message) =>
            handleMessage(message).pipe(
              Effect.catchCause(
                Effect.fnUntraced(function* (cause) {
                  yield* Effect.logError("GitHub webhook consumer defect", cause).pipe(
                    Effect.annotateLogs({ messageId: message.id }),
                  )
                  message.retry()
                }),
              ),
            ),
          ),
        ),
    )

    // Signed webhook ingress and the human sync routes live in the same
    // deployment as the consumer and workflows, so there is no internal hop
    // between acceptance and journaling.
    const HttpPlatformStubLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
      platform: "web",
      compression: {
        algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
        compressResponse: () =>
          Effect.die("HttpPlatform.compression.compressResponse not supported"),
      },
      fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
      fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse not supported"),
    })
    const env = yield* Cloudflare.Workers.WorkerEnvironment
    // The audience binding is empty during plan, when no request can arrive.
    // At runtime an empty audience matches no assertion, so a missing binding
    // fails closed rather than open.
    const accessAudience = typeof env.ACCESS_AUD === "string" ? env.ACCESS_AUD : ""
    const apiRoutes = yield* HttpRouter.toHttpEffect(
      makeRoutesLayer(secrets, { teamDomain: ACCESS_TEAM_DOMAIN, audience: accessAudience }).pipe(
        Layer.provide([Etag.layer, HttpPlatformStubLayer, Path.layer, FetchHttpClient.layer]),
      ),
    )
    // Route errors that know their response (400 for a malformed request,
    // 404 for no route) become that response; anything else is a 500.
    const api = apiRoutes.pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        const expected = HttpServerRespondable.isRespondable(error)
        return (
          expected
            ? Effect.logWarning("API request rejected", cause)
            : Effect.logError("API request failed", cause)
        ).pipe(
          Effect.andThen(
            HttpServerRespondable.toResponseOrElseDefect(
              error,
              HttpServerResponse.empty({ status: 500 }),
            ),
          ),
        )
      }),
    )

    // Requests that match a built file never reach the Worker. Everything
    // else that is not the API goes back to the asset layer, which applies
    // the single-page fallback.
    const assets = Cloudflare.fromCloudflareFetcher(env.ASSETS)
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.originalUrl)
      return url.pathname.startsWith("/api/v1/") ? yield* api : yield* assets.fetch(request)
    })

    return {
      fetch: cluster.provide(handler),
    }
  }).pipe(
    Effect.provide([
      Cloudflare.Hyperdrive.ConnectBinding,
      Cloudflare.Queues.WriteQueueBinding,
      Cloudflare.Queues.EventSourceLive,
      Cloudflare.R2.ReadWriteBucketBinding,
      Cloudflare.R2.WriteBucketBinding,
      Cloudflare.Workers.RateLimitBinding,
      Cloudflare.Workers.CronEventSourceLive,
    ]),
  ),
) {}
