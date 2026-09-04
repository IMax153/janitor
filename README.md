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

- Run the cluster Worker locally, then the web app in a second terminal:

```bash
vp run dev
vp run dev:web
```

The Worker listens on port 8787 and the web app proxies `/api` to it. Under
`alchemy dev` there is no Cloudflare edge in front of the Worker, so Access is
simulated: every request is attributed to the issuer `local-dev`, and audit
entries written locally say so. A deploy never carries that identity.

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
