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
 * Who the caller is, and what they are allowed to spend: the API-key bearer hook, the same-origin
 * gate, the two rate limiters, the route-permission check and the API-key site pin — in the order
 * `index.ts` registered them, which is behaviour (see `registerAuthHooks` below).
 */

/**
 * The route-permission gate: the single place a route's `config.permissions` declaration is
 * enforced.
 *
 * Callback-style (`(req, reply, done)`), matching `helpers/siteResolution.ts#siteEnabledPreHandler` and
 * `helpers/apiKeySite.ts#apiKeySitePinHook` — register it with
 * `app.addHook('preHandler', permissionPreHandler)`.
 *
 * Global-vs-page-rule audit (task 551, Feature 377): every `session.permissions` /
 * `apiKey.permissions` read under `backend/` was re-grepped and confirmed to check a genuinely-global
 * permission name (this hook's own `routePermissions`, `models/users.ts`'s login flattening,
 * `models/approvals.ts`, `models/groups.ts`'s `checkSiteAdminAccess()`, `controllers/terminal.ts`,
 * `helpers/rateLimit.ts`, `models/groups.ts`'s `actorForRequest()`, `api/users.ts`'s `whoAmI()`), not
 * one of the fourteen page-rule `PAGE_PERMISSIONS` strings — those may only be decided by
 * `groups.checkAccess()` / `mayOnPage()` against a page's rules. One further instance turned up in
 * that pass and was fixed there: `api/pages.ts`'s search route was scanning the GLOBAL list for
 * `write:pages`/`manage:pages`, which a group's `permissions` column never legitimately carries — see
 * `models/groups.ts`'s `mayHoldPermissionSomewhere()`. A future permission check added near any of
 * the above should keep asking the same question this comment does, not assume `session.permissions`
 * covers page-scoped names.
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
        ? req.session.permissions
        : null
    // Unauthenticated / No Permissions
    if (!permissions || permissions.length < 1) {
      reply.unauthorized()
      return
    }
    // Is Root Admin?
    if (!permissions.includes('manage:system')) {
      // Check for at least 1 permission
      const isAllowed = routePermissions.some((perms) => {
        // Check for all permissions
        if (Array.isArray(perms)) {
          return perms.every((perm) => permissions.some((p) => p === perm))
        } else {
          return permissions.some((p) => p === perms)
        }
      })
      // Forbidden
      if (!isAllowed) {
        reply.forbidden()
        return
      }
    }
  }
  done()
}

/**
 * Registers every authentication/authorization hook, in the one order they may be registered in.
 */
export function registerAuthHooks(app: FastifyInstance): void {
  // ----------------------------------------
  // API Key Authentication
  // ----------------------------------------

  app.decorateRequest('apiKey', null)

  app.addHook('onRequest', async (req, reply) => {
    // -> Bearer tokens authenticate `/_api/` calls, plus the handful of public, hostname-routed
    //    controllers that accept an API key without a session (`/_files`, `/_site`, `/_thumb` --
    //    see `helpers/apiKeySite.ts#isBearerAuthenticatedPath` for exactly which and why, OpenProject
    //    #2339). Everything else is cookie-authenticated. Note that the session is deliberately left
    //    untouched: writing to it would have @fastify/session persist a session row for every
    //    scraped request.
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
      req.apiKey = await WIKI.models.apiKeys.verify(token)
    } catch (err: any) {
      // -> Say why: the caller holds the credential and can act on "revoked" or "expired"
      WIKI.logger.debug(`Rejected an API key: ${err.message}`)
      return reply.unauthorized(err.message)
    }
    // -> Global, not per-route: a compromised key has to be caught on whichever endpoint it hits,
    //    not only the ones that remembered to attach a limiter. See helpers/rateLimit.ts for why
    //    this one specifically has no manage:system exemption.
    return limitApiKey(req, reply)
  })

  // ----------------------------------------
  // Same-Origin Check (task 2118 / WP 2105 §3)
  // ----------------------------------------

  /*
    `SameSite=Lax` (see `core/http/session.ts`) does not cover a same-site-but-different-origin
    attacker -- a page on sibling.wiki.example is "same-site" to wiki.example for cookie purposes, but
    not the wiki's own origin, and Lax still attaches the cookie to a top-level form navigation either
    way. Nothing else in the request pipeline inspects request provenance (see WP 2105's own grep for
    `csrf`/`sec-fetch`/`x-requested-with` across the repo), so a state-changing `/_api/` request riding
    on the session cookie alone -- no verified bearer token -- has to positively confirm it originated
    here. The actual decision is `shouldBlockCrossOriginApiRequest()` in `helpers/security.ts` -- kept
    as a plain function of the request rather than written inline here so it can be exercised directly
    in a test with no Fastify instance, database, or route registration needed at all; this hook is
    just the wiring.

    After the API-key hook above, so `req.apiKey` is populated for the bearer exemption; before the
    rate limiter, though the ordering between the two doesn't matter functionally.
  */
  app.addHook('onRequest', (req, reply, done) => {
    if (shouldBlockCrossOriginApiRequest(req, sessionCookieName())) {
      // -> Fails closed: a missing/foreign `Origin` (and no `Sec-Fetch-Site: same-origin`) is not
      //    what a real browser sends on a state-changing cross-document request, so there is
      //    nothing here to positively trust.
      return reply.forbidden('Cross-origin request blocked')
    }
    done()
  })

  // ----------------------------------------
  // General API Rate Limit
  // ----------------------------------------

  app.addHook('onRequest', async (req, reply) => {
    // -> After the API-key hook above, so `req.apiKey` is populated for the key it builds its
    //    counter from. See `helpers/rateLimit.ts#limitApiRequests` for the key/exemption/double-count
    //    reasoning.
    if (!req.url.startsWith('/_api/')) {
      return
    }
    return limitApiRequests(req, reply)
  })

  // ----------------------------------------
  // Public Surface Rate Limit
  // ----------------------------------------

  app.addHook('onRequest', async (req, reply) => {
    // -> The handful of root-mounted public controllers (`/sitemap.xml`, `/robots.txt`, `/_icons`,
    //    `/_files`, `/_thumb`, `/_site`) carried no throttle of any kind before this hook (OpenProject
    //    #2274) -- neither this one nor the `/_api/` limiter above ever saw them, since both are
    //    scoped to `/_api/`. Accounted into its own `public:` bucket, entirely separate from
    //    `/_api/`'s -- see `helpers/rateLimit.ts#limitPublicRequests`.
    const path = req.url.split('?')[0] ?? req.url
    if (!isPublicRateLimitedPath(path)) {
      return
    }
    return limitPublicRequests(req, reply)
  })

  // ----------------------------------------
  // Permissions
  // ----------------------------------------

  app.addHook('preHandler', permissionPreHandler)

  // ----------------------------------------
  // API key site pin
  // ----------------------------------------

  // -> OpenProject #2189/#2194: a key/token pinned to one site (`apiKeys.siteId`) must not reach
  //    another site's resources through the REST API. One global hook covering every
  //    `/sites/:siteId/...` route rather than a call added to each of the 117+ of them individually —
  //    see `helpers/apiKeySite.ts`'s own doc comment for the full reasoning and what this deliberately
  //    does not cover (a hostname- or body-resolved site, which calls `enforceApiKeySite()` directly).
  app.addHook('preHandler', apiKeySitePinHook)
}
