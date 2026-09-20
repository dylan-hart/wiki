import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { apiKeySitePinHook, isBearerAuthenticatedPath } from '../../helpers/apiKeySite.ts'
import {
  limitApiKey,
  limitApiRequests,
  limitPublicRequests,
  isPublicRateLimitedPath
} from '../../helpers/rateLimit.ts'
import { sessionCookieName, shouldBlockCrossOriginApiRequest } from '../../helpers/security.ts'

/**
 * The single place a route's `config.permissions` declaration is enforced.
 *
 * Only GLOBAL permission names can be decided here: `session.permissions` and `apiKey.permissions`
 * never carry a page-rule or site-scoped name, which is decided against a page's or site's rules by
 * `groups.checkAccess()` / `mayOnPage()` / `groups.checkSiteAccess()` instead.
 */
export function permissionPreHandler(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
): void {
  const routePermissions = req.routeOptions.config?.permissions
  if (routePermissions && routePermissions.length > 0) {
    // -> A verified API key stands in for a session, carrying the permissions of the groups it was
    //    issued for
    const permissions = req.apiKey
      ? req.apiKey.permissions
      : req.session?.authenticated
        ? (req.session.permissions ?? [])
        : null
    // -> 401 only for no verified identity at all. An authenticated identity holding NO global
    //    permissions (a Users-group-only account) is a 403 below: a 401 trips the frontend's
    //    session-expiry interceptor (`boot/api.js`), which bounces the reader to `/login`.
    if (!permissions) {
      reply.unauthorized()
      return
    }
    if (!permissions.includes('manage:system')) {
      const isAllowed = routePermissions.some((perms) => {
        if (Array.isArray(perms)) {
          return perms.every((perm) => permissions.some((p) => p === perm))
        } else {
          return permissions.some((p) => p === perms)
        }
      })
      if (!isAllowed) {
        reply.forbidden()
        return
      }
    }
  }
  done()
}

/**
 * Registration order is behaviour: the API-key hook runs first, because the same-origin gate and
 * the `/_api/` rate limiter read `req.apiKey`.
 */
export function registerAuthHooks(app: FastifyInstance): void {
  app.decorateRequest('apiKey', null)

  app.addHook('onRequest', async (req, reply) => {
    // -> Everything outside `isBearerAuthenticatedPath` is cookie-authenticated. The session is
    //    deliberately left untouched: writing to it would have @fastify/session persist a session
    //    row for every scraped request.
    if (!isBearerAuthenticatedPath(req.url)) {
      return
    }
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return
    }
    const token = header.slice('Bearer '.length).trim()
    if (!token) {
      return
    }
    try {
      req.apiKey = await CARDINAL.models.apiKeys.verify(token)
    } catch (err: any) {
      // -> `warn`, not `debug`: an operator watching for a compromised key must see a refused
      //    credential without debug logging. The reason goes back to the caller, who holds the
      //    credential and can act on "revoked" or "expired".
      CARDINAL.logger.warn('auth', 'api key refused', { error: err })
      return reply.unauthorized(err.message)
    }
    // -> Global, not per-route: a compromised key has to be caught on whichever endpoint it hits,
    //    not only the ones that remembered to attach a limiter.
    return limitApiKey(req, reply)
  })

  /*
    `SameSite=Lax` does not cover a same-site-but-different-origin attacker: a page on
    sibling.wiki.example is "same-site" to wiki.example for cookie purposes, and Lax still attaches
    the cookie to a top-level form navigation. A state-changing `/_api/` request riding on the
    session cookie alone therefore has to positively confirm it originated here.
  */
  app.addHook('onRequest', (req, reply, done) => {
    if (shouldBlockCrossOriginApiRequest(req, sessionCookieName())) {
      return reply.forbidden('Cross-origin request blocked')
    }
    done()
  })

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/_api/')) {
      return
    }
    return limitApiRequests(req, reply)
  })

  app.addHook('onRequest', async (req, reply) => {
    // -> The root-mounted public controllers are outside `/_api/`, so the limiter above never
    //    sees them. They count into their own `public:` bucket, separate from `/_api/`'s.
    const path = req.url.split('?')[0] ?? req.url
    if (!isPublicRateLimitedPath(path)) {
      return
    }
    return limitPublicRequests(req, reply)
  })

  app.addHook('preHandler', permissionPreHandler)

  // -> A key pinned to one site (`apiKeys.siteId`) must not reach another site's resources. One
  //    global hook covers every `/sites/:siteId/...` route; a route whose site is resolved from the
  //    hostname or the body calls `enforceApiKeySite()` itself.
  app.addHook('preHandler', apiKeySitePinHook)
}
