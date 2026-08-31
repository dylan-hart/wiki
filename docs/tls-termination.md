# TLS termination for multi-hostname deployments

Feature [#408](../../../work_packages/408) "Cross-subsystem per-site scoping audit" is task
[#701](../../../work_packages/701) "Resolve the TLS/SSL story for multi-hostname deployments". This
is the explicit call: **Wiki.js does not terminate TLS itself.** A reverse proxy in front of it does.

## The decision

`initHTTPServer()` (`backend/index.ts:234-266`) constructs Fastify with no `https` option — the
process only ever speaks plain HTTP. That is deliberate, not an oversight to fix:

- Multi-site support resolves which site a request belongs to by **hostname**
  (`WIKI.sitesMappings[req.hostname]`, `backend/index.ts:614`, feeding the `onRequest` hook that sets
  `req.site` for the rest of the request). Serving several hostnames' certificates out of one process
  means picking the right one per connection _before_ the HTTP layer — that's exactly what TLS's SNI
  extension exists for, and every mainstream reverse proxy (nginx, Traefik, Caddy, HAProxy, a cloud
  load balancer) already does it well, with certificate issuance/rotation (e.g. ACME/Let's Encrypt)
  as a solved, independently-updated concern.
- `trustProxy` already exists as exactly the config knob this topology needs
  (`WIKI.config.security.trustProxy`, consumed at `backend/index.ts:275` as Fastify's `trustProxy`
  option). With it enabled, Fastify reads the client's real IP and protocol from the `X-Forwarded-*`
  headers the proxy sets, instead of seeing the proxy's own loopback connection. This is precisely
  the "proxy terminates TLS, forwards plain HTTP downstream" topology `trustProxy`'s own hint text
  describes (`admin.security.trustProxyHint` in `backend/locales/en.json`): _"Should be enabled when
  using a reverse-proxy like nginx, apache, CloudFlare, etc in front of Wiki.js."_
- The Docker and Helm deployment assets under `dev/` are already built around this shape — they ship
  Wiki.js as a plain-HTTP backend service, not a TLS-terminating edge.

Building real in-process SNI support instead (per-site certificate storage and rotation, an ACME
account per site, `SecureContext` selection via `https.createServer`'s `SNICallback`) is a
meaningfully larger, independent piece of work — new schema, new admin UI, a certificate lifecycle
to operate and secure — not something to fold into this task. If that direction is ever wanted, it
belongs in its own Feature scoped for it, not a same-session addition here.

## Deploying with a reverse proxy

Put nginx, Traefik, Caddy, or equivalent in front of the Wiki.js process:

1. The proxy owns one or more certificates (per-hostname, selected via **SNI** at the TLS
   handshake — this is what lets one proxy serve several sites' certificates on the same `:443`) and
   terminates HTTPS there.
2. It forwards the request to Wiki.js over plain HTTP on `port` (`config.sample.yml`, default
   `3000`), setting the standard `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host`
   headers.
3. Enable **Trust Proxy** on the admin Security page so those headers are trusted rather than
   ignored — otherwise every request appears to arrive from the proxy's own address over plain
   HTTP, which breaks IP-based rate limiting and any HTTPS-only logic. This is the only way to set
   it that sticks: `security` (including `trustProxy`) is a DB-owned settings group
   (`models/settings.ts:139-157`), seeded into the `settings` table on first boot and loaded _after_
   `config.yml` (`core/config.ts:111`) — so a `security.trustProxy: true` written into `config.yml`
   is silently overwritten by the DB row on every subsequent boot.
4. Each site's hostname (as configured in the Sites admin area) must match the `Host` header the
   proxy forwards, since that's what `WIKI.sitesMappings[req.hostname]` matches against to resolve
   which site a request belongs to.

A minimal nginx example for two sites sharing one Wiki.js instance:

```nginx
server {
    listen 443 ssl;
    server_name wiki-a.example.com;
    ssl_certificate     /etc/ssl/wiki-a.example.com.crt;
    ssl_certificate_key /etc/ssl/wiki-a.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}

server {
    listen 443 ssl;
    server_name wiki-b.example.com;
    ssl_certificate     /etc/ssl/wiki-b.example.com.crt;
    ssl_certificate_key /etc/ssl/wiki-b.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

Traefik and Caddy both do the SNI-cert-selection-plus-forward step even more simply (Caddy issues
and renews certificates automatically per hostname it's configured to serve); the header and
`trustProxy` requirements above are identical regardless of which proxy is used.

## Related cleanup in this change

The 2.5.x `AdminSsl.vue` admin page (an in-app Let's Encrypt/custom-certificate manager, i.e. the UI
for the in-process-TLS direction this document rules out) was already dead: unreachable from
`frontend/src/router/routes.js`, still written against the removed GraphQL/Apollo client
(`this.$apollo.mutate`), Vuetify pug templates, and a direct `lodash` import. It, its disabled
nav-menu entry, and its orphaned `admin.ssl.*` locale strings are removed as part of this task,
consistent with Feature 388/task 599's prior, independent decision to delete the same dead stub for
the same reason on a different unmerged branch.

`config.sample.yml`'s `db.ssl` / `db.sslOptions` are a different, unrelated setting — the Postgres
connection's own TLS, not this document's application-level TLS — and are now commented to say so
explicitly, since the shared naming otherwise invites confusing the two.
