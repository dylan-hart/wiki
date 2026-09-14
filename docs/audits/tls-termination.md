# TLS termination for multi-hostname deployments

Feature [#408](../../../work_packages/408) "Cross-subsystem per-site scoping audit" is task
[#701](../../../work_packages/701) "Resolve the TLS/SSL story for multi-hostname deployments". This
is the explicit call: **Cardinal.js does not terminate TLS itself.** A reverse proxy in front of it does.

## The decision

`initHTTPServer()` (`backend/index.ts`, its `const app = fastify({` call) constructs Fastify with no
`https` option — the process only ever speaks plain HTTP. That is deliberate, not an oversight to fix:

- Multi-site support resolves which site a request belongs to by **hostname**
  (`WIKI.sitesMappings[req.hostname]`, `backend/index.ts`'s "Site Resolution" `onRequest` hook, feeding
  `req.site` for the rest of the request). Serving several hostnames' certificates out of one process
  means picking the right one per connection _before_ the HTTP layer — that's exactly what TLS's SNI
  extension exists for, and every mainstream reverse proxy (nginx, Traefik, Caddy, HAProxy, a cloud
  load balancer) already does it well, with certificate issuance/rotation (e.g. ACME/Let's Encrypt)
  as a solved, independently-updated concern.
- `trustProxy` already exists as exactly the config knob this topology needs
  (`WIKI.config.security.trustProxy`, consumed inside `initHTTPServer()`'s `fastify({ ... })` call as
  its `trustProxy` option). Set to the proxy's own address or CIDR range, it makes Fastify read the
  client's real IP and protocol from the `X-Forwarded-*` headers the proxy sets, instead of seeing the
  proxy's own loopback connection — but only when a request actually arrives from that address, so a
  client connecting directly cannot forge those headers itself. This is precisely the "proxy
  terminates TLS, forwards plain HTTP downstream" topology `trustProxy`'s own hint text describes
  (`admin.security.trustProxyHint` in `backend/locales/en.json`): _"Should be enabled when using a
  reverse-proxy like nginx, apache, CloudFlare, etc in front of Wiki.js."_ (quoted verbatim — that
  locale string still carries the pre-fork product name.)
- The Docker deployment assets under `dev/` are already built around this shape — they ship Cardinal.js
  as a plain-HTTP backend service, not a TLS-terminating edge.

Building real in-process SNI support instead (per-site certificate storage and rotation, an ACME
account per site, `SecureContext` selection via `https.createServer`'s `SNICallback`) is a
meaningfully larger, independent piece of work — new schema, new admin UI, a certificate lifecycle
to operate and secure — not something to fold into this task. If that direction is ever wanted, it
belongs in its own Feature scoped for it, not a same-session addition here.

## Deploying with a reverse proxy

Put nginx, Traefik, Caddy, or equivalent in front of the Cardinal.js process:

1. The proxy owns one or more certificates (per-hostname, selected via **SNI** at the TLS
   handshake — this is what lets one proxy serve several sites' certificates on the same `:443`) and
   terminates HTTPS there.
2. It forwards the request to Cardinal.js over plain HTTP on `port` (`config.sample.yml`, default
   `3000`), setting the standard `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host`
   headers — **overwriting**, not appending to, any `X-Forwarded-For` the request already carried.
   This is not automatic: nginx's commonly-copied `proxy_set_header X-Forwarded-For
$proxy_add_x_forwarded_for;` idiom **appends** the proxy's own view of the connection onto whatever
   the client already sent, rather than replacing it — so a client's own forged
   `X-Forwarded-For: 1.2.3.4` survives as the _first_
   entry in the header nginx forwards. That matters because the auth rate limiter's whole identity
   depends on it: Fastify's `req.ip` (`@fastify/forwarded`) is read as the _first_, left-most entry of
   the header once it is trusted — the one closest to the original client, which is exactly the one a
   direct client controls when the header is merely appended to. Use `proxy_set_header X-Forwarded-For
$remote_addr;` instead (the nginx example below does this): that overwrites the header with only
   what nginx itself observed as the connecting address, discarding anything the client sent.
3. Set `security.trustProxy` to the reverse proxy's own address or CIDR range via the admin Security
   page — e.g. `10.0.0.5` for a proxy on a fixed internal address, or `10.0.0.0/8` for a range,
   comma-separated for more than one. This is what makes Cardinal.js trust the `X-Forwarded-*` headers
   **only when they arrive from that address** — not `security.trustProxy: true`, which trusts them
   unconditionally from anywhere, including a client connecting directly. With `true`,
   `X-Forwarded-For` becomes a header any client can set on its own request, so `req.ip` (and
   therefore the login/2FA/password-reset rate limiter, which counts attempts per `req.ip`) is
   client-chosen — an unlimited-attempts bypass, one spoofed header at a time. Left unset (`false`,
   the default) instead, every request behind the proxy appears to arrive from the proxy's own
   address over plain HTTP, which breaks IP-based rate limiting the opposite way — everyone behind
   the proxy shares one bucket — and any HTTPS-only logic. The address/CIDR form is what avoids both
   failure modes.

   The admin Security page is the only way to set `trustProxy` that sticks: `security` (including
   `trustProxy`) is a DB-owned settings group (`models/settings.ts:139-157`), seeded into the
   `settings` table on first boot and loaded _after_ `config.yml` (`core/config.ts:111`) — so a
   `security.trustProxy` value written into `config.yml` is silently overwritten by the DB row on
   every subsequent boot.

4. Each site's hostname (as configured in the Sites admin area) must match the `Host` header the
   proxy forwards, since that's what `WIKI.sitesMappings[req.hostname]` matches against to resolve
   which site a request belongs to. **This is security-relevant, not just routing plumbing**: with
   `trustProxy` correctly scoped to the proxy's own address as above, Cardinal.js also only honors
   `X-Forwarded-Host` from that same trusted address — a request arriving any other way is resolved
   against the socket's own `Host` header instead, so a client cannot use `X-Forwarded-Host` to name a
   different site than the one it actually connected to and read that site's guest-visible pages,
   sitemap, or assets.

A minimal nginx example for two sites sharing one Cardinal.js instance:

```nginx
server {
    listen 443 ssl;
    server_name wiki-a.example.com;
    ssl_certificate     /etc/ssl/wiki-a.example.com.crt;
    ssl_certificate_key /etc/ssl/wiki-a.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        # Overwrites, not appends -- see step 2 above. A client-forged X-Forwarded-For must not
        # survive into what Cardinal.js's auth rate limiter keys req.ip on.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Security-relevant, not just routing plumbing -- see step 4 above. Cardinal.js only trusts this
        # (and X-Forwarded-For above) from security.trustProxy's configured address/CIDR, which is
        # what keeps a request from naming a different site than the one it actually connected to.
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
        # Overwrites, not appends -- see step 2 above. A client-forged X-Forwarded-For must not
        # survive into what Cardinal.js's auth rate limiter keys req.ip on.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Security-relevant, not just routing plumbing -- see step 4 above. Cardinal.js only trusts this
        # (and X-Forwarded-For above) from security.trustProxy's configured address/CIDR, which is
        # what keeps a request from naming a different site than the one it actually connected to.
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
