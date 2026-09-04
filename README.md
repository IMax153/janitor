# Vite+ Monorepo Starter

A starter for creating a Vite+ monorepo.

## Development

- Check everything is ready:

```bash
vp run ready
```

- Run the tests:

```bash
vp run -r test
```

- Build the monorepo:

```bash
vp run -r build
```

- Run everything:

```bash
vp run dev
```

`alchemy dev` starts both Workers: the API on port 8787, and the web app's own
Vite dev server, with hot reload and the foldkit devtools port, on 1337. Open
the second one. Deployed, the two Workers share one hostname and Cloudflare
routes `/api/v1/*` to the API; locally that routing is a proxy in
`apps/web/vite.config.ts`.

There is no Cloudflare edge locally, so Access is simulated: every request is
attributed to the issuer `local-dev`, and audit entries written locally say
so. A deploy never carries that identity.

To point the local web app at a deployed stage instead, log in through
`cloudflared` and pass the token along with the origin. Both go in `.env`,
which direnv loads and git ignores:

```bash
cloudflared access login https://janitor.effectful.co
cloudflared access token --app https://janitor.effectful.co
```

```
JANITOR_API_ORIGIN=https://janitor.effectful.co
CF_ACCESS_TOKEN=<the token>
```

The token expires with the Access session. Anything you save in that mode
changes the deployed configuration.
