# Comment recommendations: OpenProject #3572 (live trustProxy)

Code comments made stale by this change. Not applied, per the comments policy.

## `backend/core/http/server.ts`, the comment above `trustProxy: createLiveTrustProxy()`

The comment says the value is a boolean or string "passed through verbatim" and that Fastify compiles
the string. Neither is true any more. Suggested replacement:

```
// -> Always a function, never the raw setting: Fastify only reads X-Forwarded-Host/Proto/For when
//    `trustProxy` is truthy at construction, so a function is what lets an admin save turn it on
//    without a restart (`trustProxy.ts`). Every hostname-keyed site lookup reads `req.hostname`, so a
//    trusted-proxy address/CIDR list, not a bare `true`, is what keeps an untrusted client's
//    `X-Forwarded-Host` from steering a request to another site -- see `docs/audits/tls-termination.md`.
```

## `backend/models/security.ts`, docblock on `validateTrustProxySpec`

"the same comma-split and `proxyAddr.compile()` that Fastify's own `getTrustProxyFn` applies" is now
"`helpers/security.ts#compileTrustProxyList`, the compile the live trust function uses at request
time". Suggested:

```
/**
 * Compiles through `compileTrustProxyList`, the same function `core/http/trustProxy.ts` uses at
 * request time, so "accepted by the admin form" cannot drift from "trusted at request time" -- a
 * trailing comma or blank entry (`'10.0.0.0/8,'`) included.
 */
```

## `backend/models/security.ts`, docblock on `class Security`

"a save here only takes effect on the next restart" is no longer true of `trustProxy`. Suggested:

```
/**
 * Most of this blob is read once, while the HTTP server is being built (`core/http/security.ts`,
 * `core/http/session.ts`), so a save here only takes effect on the next restart. `trustProxy` is the
 * exception: `core/http/trustProxy.ts` re-reads it per request.
 */
```

## `backend/models/security.ts`, comment inside `validate` above the `trustProxy` check

"passed straight through to Fastify's own `trustProxy` option" should read "compiled by
`core/http/trustProxy.ts`".

## `frontend/src/pages/AdminSecurity.vue`

- Above the `restartRequired` banner: "These are read when the HTTP server builds its plugin chain, not
  per request" stays true for the fields the banner still covers; append "(Trust Proxy excepted)".
- Above the insecure-cookie warning: "flipping the toggle above hides the warning at once, not after a
  restart + reload" now only needs "not after a reload".
