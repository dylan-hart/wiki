import type { FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifySession from '@fastify/session'

import { assertValidAuthSecret } from '../../helpers/authSecret.ts'
import { authSecretSigner } from '../../helpers/authSecretSigner.ts'
import { sessionCookieName } from '../../helpers/security.ts'
import { sessionStoreAdapter } from '../../models/sessions.ts'

/**
 * Cookie parsing, the session store, and the cookie-security diagnostic hook that reports on how the
 * two are actually reaching the browser.
 */
export function registerSession(app: FastifyInstance): void {
  // Fail closed rather than silently register the session/cookie plugins with a missing or
  // too-short secret -- see `helpers/authSecret.ts` for why this exists.
  assertValidAuthSecret(WIKI.config.auth.secret)

  // `authSecretSigner` (OpenProject #2172) hands both plugins an object that reads
  // `WIKI.config.auth.secret` at call time instead of a value captured once here at registration, so
  // `models/sessions.ts#rotateSecret()` (verified under a real two-instance HA setup for task 589)
  // takes effect on a still-running instance immediately: this instance signs and verifies against the
  // rotated secret starting with the very next request, and so does every other instance the moment
  // `WIKI.events.inbound`'s `reloadConfig` (already fanned out by `saveToDb()`) reassigns its own
  // `WIKI.config`. No restart, and no plugin re-registration, required.
  app.register(fastifyCookie, {
    secret: authSecretSigner,
    hook: 'onRequest'
  })
  app.register(fastifySession, {
    secret: authSecretSigner,
    // -> task 2109: `__Host-`-prefixed and pinned explicit, not `secure: 'auto'` -- see
    //    `sessionCookieName()`'s doc comment for why `cookiePrefix` (what the task's own text
    //    suggested) cannot get there, and the two notes below for what pinning these two costs.
    //    `security.cookieSecure` (default `true`) is the escape hatch for a plain-HTTP dev instance --
    //    see its doc comment in `base.yml`.
    cookieName: sessionCookieName(),
    cookie: {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      /*
        Unconditionally true when `security.cookieSecure` isn't explicitly `false`, not `secure:
        'auto'` (task 2109 / WP 2105 §2): the `__Host-` name above is only honoured by a browser when
        the `Set-Cookie` response itself carries `Secure` -- @fastify/session's 'auto' resolves that to
        `false` on any request THIS instance sees as plain http
        (`node_modules/@fastify/session/lib/cookie.js`), which includes both the dev server
        (`npm run dev` serves :3000 over http, matching config.sample.yml's default) and a
        genuinely-HTTPS deployment sitting behind a reverse proxy that isn't declared via
        `trustProxy` -- see `models/security.ts#observeRequest`, which exists to catch exactly that
        misconfiguration. In the trustProxy-off-but-really-HTTPS case, 'auto' would silently drop the
        whole `__Host-` cookie rather than merely downgrade it, since a missing `Secure` fails the
        prefix outright; forcing it `true` fixes that case unconditionally instead.

        This does NOT, on its own, make a plain-HTTP dev instance work: @fastify/session's own `onSend`
        hook refuses to ever emit a `Secure`-flagged cookie unless it saw the connection itself as TLS
        (`request.protocol === 'https'`), which a bare `node backend` over plain HTTP never is --
        loopback or not, contrary to what an earlier version of this comment assumed (OpenProject bug
        report, 2026-08-31: verified against a real `@fastify/session` request, not merely inferred).
        `security.cookieSecure: false` is the documented way out of that for a dev instance -- see
        `base.yml`. Left at its default `true`, this is unchanged: a deployment with no TLS anywhere in
        the chain (not even a proxy) fails closed -- no session cookie at all, rather than an insecure
        one -- which is the point.
      */
      secure: WIKI.config.security?.cookieSecure !== false,
      // -> Explicit, not left to 'auto' forcing it only on the non-https branch (task 2109 / WP
      //    2105 §2): a correctly-deployed HTTPS instance was emitting `Secure` with NO `SameSite`
      //    at all, which is exactly backwards for CSRF exposure. 'lax', never 'strict' -- the
      //    OAuth/SAML provider callback is a cross-site top-level navigation back to this origin,
      //    which 'strict' would refuse to attach the cookie to.
      sameSite: 'lax'
    },
    saveUninitialized: false,
    // -> OpenProject #2569: `rolling` (default `true`, verified against `@fastify/session@11.1.2`'s
    //    own `shouldSaveSession()`) makes its `onSend` hook call `session.save()` -- a full round trip
    //    through `sessionStoreAdapter()` to Postgres -- on EVERY request that carries an already-
    //    established session cookie, even a plain `GET` a handler never touches `req.session` on (the
    //    RTL e2e failures: `GET /_api/locales/en/strings`, `publicAccess: true`). That async store
    //    write races the reply's own completion; when the store's callback reports late (an error, or
    //    just a slow tick), Fastify's error path tries to finish a reply it can no longer write to,
    //    logging `FST_ERR_REP_ALREADY_SENT` and hanging the connection until the client times out --
    //    which is what stalled the locale-switch UI in `tests/rtl.spec.js`. `rolling: false` makes
    //    `shouldSaveSession()` fall through to `request.session.isModified()` alone, so the store round
    //    trip -- and the race -- only happens on a request that genuinely mutates `req.session` (login,
    //    logout, 2FA, a permission change), for every route, not just this one. There is no per-route
    //    way to scope `rolling` through this plugin's public API (it's a registration-time closure), so
    //    this is a deliberate, global tradeoff: because `@fastify/session` only re-sends a refreshed
    //    `Set-Cookie` when `save()` actually ran, a session's expiry stops sliding with activity and
    //    instead becomes fixed at `cookie.maxAge` (30 days, above) from the last request that actually
    //    modified it.
    rolling: false,
    store: sessionStoreAdapter()
  })

  // ----------------------------------------
  // Cookie Security Diagnostic (task 833)
  // ----------------------------------------

  // -> Feeds `Security#observeRequest` so the admin area's security view can warn about the
  //    reverse-proxy cookie misconfiguration described on that method -- see its doc comment.
  //    Registered after the session cookie is parsed but does not depend on it; placement here is
  //    just "grouped with the rest of the cookie/session wiring it explains".
  app.addHook('onRequest', (req, reply, done) => {
    WIKI.models.security.observeRequest(req.headers, req.protocol)
    done()
  })
}
