import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

/** The Zero Trust organization whose GitHub identity provider admits people. */
export const TEAM_DOMAIN = "effectful.cloudflareaccess.com"
const GITHUB_IDENTITY_PROVIDER_ID = "0d007daa-be1b-4e31-b538-98a8048f6863"
const GITHUB_ORGANIZATION = "Effectful-Tech"

/**
 * The Access application, declared on its own rather than owned by a Worker.
 * Two Workers serve this hostname, so the application protects the hostname
 * rather than a Worker destination: the edge decides before the request is
 * routed, which covers both. Owning it from either Worker would also make
 * the two reference each other.
 *
 * `alchemy dev` declares nothing here. There is no edge locally, so the
 * `dev.access` stub on the API Worker stands in for it.
 */
export const application = (domain: string) =>
  Cloudflare.Access.Application("Access", {
    type: "self_hosted",
    name: "Janitor",
    domain,
    sessionDuration: "8h",
    allowedIdps: [GITHUB_IDENTITY_PROVIDER_ID],
    autoRedirectToIdentity: true,
    // Spike policy: any member of the organization. The split into a
    // configuration team and a stricter operator team comes later.
    policies: [
      {
        name: `${GITHUB_ORGANIZATION} members`,
        decision: "allow",
        include: [
          {
            githubOrganization: {
              identityProviderId: GITHUB_IDENTITY_PROVIDER_ID,
              name: GITHUB_ORGANIZATION,
            },
          },
        ],
      },
    ],
  })

/**
 * GitHub cannot log in. A more specific application beats the broader one,
 * so this path skips Access and keeps its signature check.
 */
export const webhookBypass = (domain: string) =>
  Cloudflare.Access.Application("WebhookBypass", {
    type: "self_hosted",
    name: "Janitor GitHub webhooks",
    domain: `${domain}/api/v1/webhooks/github`,
    appLauncherVisible: false,
    policies: [{ name: "GitHub deliveries", decision: "bypass", include: ["everyone"] }],
  })

/** Both applications, or nothing when running under `alchemy dev`. */
export const declare = Effect.fnUntraced(function* (options: {
  readonly dev: boolean
  readonly domain: string
}) {
  if (options.dev) return undefined
  const app = yield* application(options.domain)
  yield* webhookBypass(options.domain)
  return app
})
