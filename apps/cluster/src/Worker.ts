import * as AlchemyCloudflareCluster from "@effect/platform-cloudflare/AlchemyCloudflareCluster"
import * as Cloudflare from "alchemy/Cloudflare"
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
import { RoutesLayer as WebhookRoutesLayer } from "./Ingress/Routes.ts"
import * as PayloadCipher from "./PayloadCipher.ts"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
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
import { SyncTargets } from "./SyncTargets.ts"
import { GitHubWebhookJournal } from "./GitHub/WebhookJournal.ts"
import {
  ProjectGitHubWebhookLayer,
  ProjectGitHubWebhookRegistration,
} from "./GitHub/ProjectWebhook.ts"
import { WorkflowDispatcher } from "./WorkflowDispatcher.ts"
import { WorkflowOutbox } from "./WorkflowOutbox.ts"
import { WorkflowOutboxCronLayer, WorkflowOutboxCronName } from "./WorkflowOutboxCron.ts"

export default class ClusterWorker extends Cloudflare.Worker<ClusterWorker>()(
  "ClusterWorker",
  {
    main: import.meta.url,
    compatibility: { flags: ["nodejs_compat"] },
  },
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

    const GitHubPayloadCipherLayer = PayloadCipher.layer(
      PayloadCipher.config({
        key: "GITHUB_WEBHOOK_PAYLOAD_KEY",
        keyId: "GITHUB_WEBHOOK_PAYLOAD_KEY_ID",
      }),
    )

    const GitHubTransportLayer = GitHubTransport.layer.pipe(
      Layer.provideMerge(
        GitHubAppAuth.layer(
          GitHubAppAuth.config({
            appId: "GITHUB_APP_ID",
            privateKey: "GITHUB_APP_PRIVATE_KEY",
          }),
        ),
      ),
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
      Layer.provideMerge(SyncPlanner.layer),
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

    // Signed webhook ingress lives in the same deployment as the consumer and
    // workflows, so there is no internal hop between acceptance and journaling.
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
    const webhookRoutes = yield* HttpRouter.toHttpEffect(
      WebhookRoutesLayer.pipe(Layer.provide([Etag.layer, HttpPlatformStubLayer, Path.layer])),
    )
    const webhooks = Effect.orElseSucceed(webhookRoutes, () =>
      HttpServerResponse.empty({ status: 500 }),
    )

    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.originalUrl)
      return url.pathname.startsWith("/api/v1/")
        ? yield* webhooks
        : HttpServerResponse.empty({ status: 404 })
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
