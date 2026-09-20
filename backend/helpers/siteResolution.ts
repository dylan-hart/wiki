import type { FastifyReply, FastifyRequest } from 'fastify'

import { isValidUuid } from './common.ts'
import { appendCspDirective, frameAncestorsDirective } from './security.ts'

export type RequestSiteResolution =
  | { outcome: 'exempt' }
  | { outcome: 'not-found' }
  | { outcome: 'disabled'; site: Record<string, any> }
  | { outcome: 'ok'; site: Record<string, any> }

/**
 * Same exact-then-`*` precedence as `siteIdForHostname`, so a request sees the site the SEO hook in
 * `core/http/siteRouting.ts` already used to decide whether to strip a page extension.
 *
 * `exemptSegments` are first path segments that must reach the app shell whatever the hostname
 * resolves to — the fix path for a disabled or unmatched site has to survive what it corrects.
 *
 * `hostname` is trusted as-is. Refusing a forged `X-Forwarded-Host` happens one layer up: Fastify's
 * `request.hostname` getter only reads that header from a peer `security.trustProxy` covers.
 */
export function resolveRequestSite({
  firstSegment,
  hostname,
  sitesMappings,
  sites,
  exemptSegments
}: {
  firstSegment: string
  hostname: string
  sitesMappings: Record<string, string>
  sites: Record<string, any>
  exemptSegments: ReadonlySet<string>
}): RequestSiteResolution {
  if (exemptSegments.has(firstSegment)) {
    return { outcome: 'exempt' }
  }
  const siteId = sitesMappings[normalizeHostname(hostname)] || sitesMappings['*']
  const site = siteId ? sites[siteId] : null
  if (!site) {
    return { outcome: 'not-found' }
  }
  if (site.isEnabled === false) {
    return { outcome: 'disabled', site }
  }
  return { outcome: 'ok', site }
}

export const SITE_DISABLED_MESSAGE = 'This wiki site is currently disabled.'

export const SITE_MISSING_MESSAGE = 'This site does not exist.'

/**
 * `CARDINAL.sitesMappings` is keyed lowercase, while Fastify's `req.hostname` preserves the `Host`
 * header's case. Every lookup and the write side fold through here rather than lowercasing for
 * themselves, so a mixed-case `Host` cannot fall through to the `*` catch-all.
 */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase()
}

/**
 * The one `sitesMappings` lookup — folded hostname, then the `*` catch-all. Never index
 * `CARDINAL.sitesMappings` with a raw `req.hostname`.
 *
 * @param strict Refuse the `*` catch-all: answers whether this exact hostname is configured, rather
 *   than which site would serve it
 */
export function siteIdForHostname(
  hostname: string | undefined,
  { strict = false }: { strict?: boolean } = {}
): string | undefined {
  const direct = hostname ? CARDINAL.sitesMappings[normalizeHostname(hostname)] : undefined
  if (strict) {
    return direct
  }
  return direct || CARDINAL.sitesMappings['*']
}

/**
 * Unlike `siteIdForHostname`, hands back the site record, and a request with no `Host` at all
 * resolves to null rather than to the `*` catch-all.
 */
export async function siteForHostname(
  hostname: string | undefined,
  { strict = false }: { strict?: boolean } = {}
): Promise<any> {
  return hostname ? await CARDINAL.models.sites.getSiteByHostname({ hostname, strict }) : null
}

/**
 * `param` may be the sentinel `current` (whichever site this request was addressed to), a site id,
 * or a hostname. A literal `current` on a request carrying no `Host` header is deliberately read as
 * a hostname rather than special-cased into a null.
 */
export async function resolveSiteParam(
  param: string,
  hostname: string | undefined,
  { strict = false }: { strict?: boolean } = {}
): Promise<any> {
  if (param === 'current' && hostname) {
    return siteForHostname(hostname, { strict })
  }
  if (isValidUuid(param)) {
    return CARDINAL.models.sites.getSiteById({ id: param })
  }
  return CARDINAL.models.sites.getSiteByHostname({ hostname: param, strict })
}

/**
 * For a site resolved OUTSIDE the page/shell hook in `core/http/siteRouting.ts` — an API route or
 * static controller. Those requests are not navigations a browser can be bounced to an `/_error/*`
 * page from, so the outcomes are told apart by status code: a disabled site answers `403` rather
 * than `404`, so a client can tell "wrong id" from "right id, wait for it to come back". A missing
 * site is the caller's own 404 to answer, and nothing to guard here.
 *
 * Returns `true` once a reply has been sent, which the caller answers with `return reply` — never a
 * bare `return`, which in an `async` handler makes Fastify write the same reply a second time.
 */
export function guardSiteEnabled(
  site: { isEnabled?: boolean } | null | undefined,
  reply: FastifyReply
): boolean {
  if (site?.isEnabled === false) {
    reply.forbidden(SITE_DISABLED_MESSAGE)
    return true
  }
  return false
}

export function embedAllowedOrigins(site: Record<string, any> | null | undefined): string[] {
  const origins = site?.config?.security?.embedAllowedOrigins
  return Array.isArray(origins) ? origins : []
}

/**
 * Appends to whatever helmet already put on `Content-Security-Policy`, never replacing it; a no-op
 * for an empty allowlist. Relies on `core/http/siteRouting.ts#registerSiteResolution`'s hook being
 * registered after `core/http/security.ts#registerSecurity`, so `reply.getHeader()` already sees
 * helmet's value.
 */
export function applyEmbedFrameAncestors(
  site: Record<string, any> | null | undefined,
  reply: Pick<FastifyReply, 'getHeader' | 'header'>
): void {
  const directive = frameAncestorsDirective(embedAllowedOrigins(site))
  if (!directive) {
    return
  }
  reply.header(
    'content-security-policy',
    appendCspDirective(reply.getHeader('content-security-policy'), directive)
  )
}

/**
 * Registered once on `api/index.ts`'s `contentApp` scope: answers the unknown-site 404 and the
 * disabled-site 403 for every route whose path names `siteId`, so a route under that scope may
 * assume its site exists, and a new route file inherits both with no call of its own.
 *
 * Hook ORDER decides which answer a caller sees. `core/http/authHooks.ts#permissionPreHandler` is
 * on the root app and runs BEFORE this, so a route declaring `config.permissions` answers 401/403
 * first and an unauthorized caller learns nothing about which site ids exist. A route declaring
 * none — public, or checking a page or `site:*` permission in its handler — answers this 404 before
 * its own authorization runs. Deliberate: those routes are open to an anonymous caller, so a site
 * id's existence is already discoverable through them.
 *
 * Two deliberate exceptions. `api/bootstrap.ts` resolves its site by hostname, not a `:siteId`
 * param, so it keeps its own `guardSiteEnabled` call. `api/sites.ts` is registered outside
 * `contentApp`: it administers the site RECORD, keeps its own 404s, and must go on working against
 * a disabled site.
 */
export function siteEnabledPreHandler(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
): void {
  const siteId = (req.params as { siteId?: string } | undefined)?.siteId
  if (siteId) {
    if (!CARDINAL.sites[siteId]) {
      reply.notFound(SITE_MISSING_MESSAGE)
      return
    }
    if (guardSiteEnabled(CARDINAL.sites[siteId], reply)) {
      return
    }
  }
  done()
}
