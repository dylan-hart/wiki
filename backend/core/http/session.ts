import type { FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifySession from '@fastify/session'

import { assertValidAuthSecret } from '../../helpers/authSecret.ts'
import { authSecretSigner } from '../../helpers/authSecretSigner.ts'
import { sessionCookieName } from '../../helpers/security.ts'
import { sessionStoreAdapter } from '../../models/sessions.ts'

export function registerSession(app: FastifyInstance): void {
  assertValidAuthSecret(CARDINAL.config.auth.secret)

  // `authSecretSigner` reads `CARDINAL.config.auth.secret` at call time rather than capturing it at
  // registration, so `models/sessions.ts#rotateSecret()` takes effect on a running instance with no
  // restart or plugin re-registration.
  app.register(fastifyCookie, {
    secret: authSecretSigner,
    hook: 'onRequest'
  })
  app.register(fastifySession, {
    secret: authSecretSigner,
    cookieName: sessionCookieName(),
    cookie: {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      /*
        Not `secure: 'auto'`: a browser honours the `__Host-` cookie name only when `Set-Cookie`
        carries `Secure`, and 'auto' resolves to `false` on any request this instance sees as plain
        http -- including an HTTPS deployment behind a reverse proxy not declared via `trustProxy`,
        where the whole cookie would be silently dropped.

        @fastify/session never emits a `Secure` cookie unless `request.protocol === 'https'`, so a
        deployment with no TLS anywhere in the chain fails closed: no session cookie at all.
        `security.cookieSecure: false` is the way out for a plain-HTTP dev instance -- see
        `base.yml`.
      */
      secure: CARDINAL.config.security?.cookieSecure !== false,
      // -> Explicit: without `secure: 'auto'`, @fastify/session sets no `SameSite` of its own.
      //    'lax', never 'strict' -- the OAuth/SAML provider callback is a cross-site top-level
      //    navigation back to this origin, which 'strict' would refuse to attach the cookie to.
      sameSite: 'lax'
    },
    saveUninitialized: false,
    // -> `rolling` (default `true`) makes `@fastify/session` save -- a Postgres round trip through
    //    `sessionStoreAdapter()` -- on every request carrying a session, modified or not. That
    //    async write races the reply: a late store callback has Fastify finish a reply it can no
    //    longer write to (`FST_ERR_REP_ALREADY_SENT`), hanging the connection. `false` saves only a
    //    modified session. The tradeoff is global, since the plugin offers no per-route scope:
    //    expiry stops sliding with activity and is `cookie.maxAge` from the last modifying request.
    rolling: false,
    store: sessionStoreAdapter()
  })

  // -> Feeds `Security#observeRequest`, so the admin security view can warn about a reverse-proxy
  //    cookie misconfiguration. Independent of the session; it only sits with the cookie wiring.
  app.addHook('onRequest', (req, reply, done) => {
    CARDINAL.models.security.observeRequest(req.headers, req.protocol)
    done()
  })
}
