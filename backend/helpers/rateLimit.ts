import { LRUCache } from 'lru-cache'
import { durationToSeconds } from './common.ts'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { RateLimitPolicy, RateLimitVerdict } from '../models/rateLimits.ts'
/**
 * In-process memo of currently-banned keys, so a request from a key that is already serving a ban
 * can be refused without the round trip `WIKI.models.rateLimits.consume()` would otherwise make to
 * Postgres for every single request — an UPDATE against the same hot row, on the pool every other
 * request shares, purely to re-confirm a ban that was already established.
 *
 * Refusal-only, deliberately: only a *banned* verdict is ever written here, never an allowed one.
 * `models/rateLimits.ts`'s header comment is explicit that the real counter has to stay a shared,
 * database-backed one so two instances behind a load balancer agree on it — a grant-side cache would
 * let one instance keep answering "allowed" out of a stale local memo after another instance's
 * database write should have banned the key. A refusal can never go stale in the dangerous direction:
 * the worst a missed refusal-memo does is one avoidable database write, not a bypassed ban, and the
 * entry's TTL (set to the ban's own `retryAfter`) means it is never wrong for longer than the ban
 * itself already runs.
 *
 * Shared by every caller of {@link consumeWithBanMemo} below — `limitAuthAttempts`, `limitApiRequests`,
 * `limitRenders` and `limitApiKey` all key into the same instance rather than each keeping its own,
 * since the underlying key strings are already namespaced (`auth:`, `api:`, `render:`, `apikey:`) and
 * nothing is gained by splitting the memo four ways.
 *
 * Exported so `rateLimit.test.ts` can `.clear()` it between test cases that reuse the same IP/key
 * across otherwise-independent tests; nothing else needs to reach in.
 */
export const activeBanMemo = new LRUCache<string, number>({
  max: 5000,
  // `ttlResolution` defaults to 1ms, debouncing repeated staleness checks onto one cached
  // `perf.now()` reading within that window. Fine for most uses, but the reported `Retry-After`
  // recomputed from `getRemainingTTL` below is worth keeping exact rather than off by up to a
  // millisecond, and a rate-limit hook is never called often enough for the extra `perf.now()`
  // calls this costs to matter.
  ttlResolution: 0
})

/**
 * `WIKI.models.rateLimits.consume()`, fronted by {@link activeBanMemo}.
 *
 * A key already in the memo is refused immediately, with `retryAfter` recomputed from the memo
 * entry's own remaining TTL (so it counts down correctly across repeated refused requests, rather
 * than reporting whatever `retryAfter` the ban started with) and `hits` carried over from the verdict
 * that created the memo entry — accurate for the whole ban, since a banned key does not accumulate
 * further hits.
 *
 * Otherwise this reaches the database exactly as before. A verdict that comes back banned is written
 * into the memo, TTL'd to its own `retryAfter`; an allowed verdict is returned as-is and never
 * memoized, so a permitted request always reaches SQL.
 */
async function consumeWithBanMemo(key: string, policy: RateLimitPolicy): Promise<RateLimitVerdict> {
  const memoizedHits = activeBanMemo.get(key)
  if (memoizedHits !== undefined) {
    const retryAfter = Math.max(1, Math.ceil(activeBanMemo.getRemainingTTL(key) / 1000))
    return { allowed: false, hits: memoizedHits, retryAfter }
  }
  const verdict = await WIKI.models.rateLimits.consume(key, policy)
  if (!verdict.allowed && verdict.retryAfter > 0) {
    activeBanMemo.set(key, verdict.hits, { ttl: verdict.retryAfter * 1000 })
  }
  return verdict
}

/**
 * Defaults for the limit on the authentication endpoints, used until an administrator saves their own
 * and whenever a stored value is missing or unusable. Ten attempts in five minutes is far more than a
 * person signing in needs and far less than guessing a password takes.
 */
const AUTH_DEFAULTS: RateLimitPolicy = {
  max: 10,
  windowSeconds: 300,
  banSeconds: 900
}

/**
 * Defaults for the general API limit, used until an administrator saves their own and whenever a
 * stored value is missing or unusable.
 *
 * Deliberately looser than {@link AUTH_DEFAULTS}: this guards the API surface as a whole against
 * runaway or abusive clients, not credential guessing, and legitimate bulk use (a script paging
 * through content, an integration syncing on a schedule) needs real headroom. 300 requests in five
 * minutes is generous for that and still catches a client running away.
 */
const API_DEFAULTS: RateLimitPolicy = {
  max: 300,
  windowSeconds: 300,
  banSeconds: 900
}

/**
 * The limit on asking for a page to be rendered.
 *
 * Not configurable, unlike the authentication limit above: what this protects is the host rather than
 * a secret, and no deployment has a reason to raise it. How many browsers run at once is settled by
 * the render queue rather than here — this only keeps one client from filling that queue faster than
 * anything could drain it. Ten in five minutes is far more than re-rendering a stale page takes.
 *
 * Exported so `mcp/tools/renderDiagram.ts` can consume it directly against
 * `WIKI.models.rateLimits` — an MCP tool call has no Fastify `req`/`reply` to hang the
 * {@link limitRenders} `preHandler` off of, but it is the same expensive, Puppeteer-backed operation
 * this policy exists to bound, so it shares the exact same numbers rather than inventing its own.
 */
export const RENDER_LIMIT: RateLimitPolicy = {
  max: 10,
  windowSeconds: 300,
  banSeconds: 300
}

/**
 * The configured policy.
 *
 * Every field falls back on its own, so one unusable value leaves the rest of the limit standing
 * rather than turning it off — which is the failure mode worth avoiding here. The two durations are
 * stored as an operator wrote them (`5m`, `15m`, `1d`), the way the JWT settings beside them are.
 */
function authPolicy(): RateLimitPolicy {
  const security = WIKI.config.security ?? {}
  const max = Number(security.authRateLimitMax)
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : AUTH_DEFAULTS.max,
    windowSeconds: durationToSeconds(security.authRateLimitWindow, AUTH_DEFAULTS.windowSeconds),
    banSeconds: durationToSeconds(security.authRateLimitBan, AUTH_DEFAULTS.banSeconds)
  }
}

/**
 * Refuse an attempt at an authentication endpoint once a client has made too many.
 *
 * Written as a per-route `onRequest` hook — `{ onRequest: limitAuthAttempts, schema: … }` — so that it
 * runs before the body is even parsed, and so that the routes it guards say so where they are declared
 * rather than in a list somewhere else. The endpoints that carry it are the ones where the request
 * IS the guess: signing in, answering a second factor, changing a password from the login screen,
 * a passkey ceremony, and unlocking a page.
 *
 * One counter per client address, shared by all of them: an attacker working through passwords on two
 * of these endpoints is one attacker, and splitting the count per endpoint would let them have the
 * limit twice over. `req.ip` is what the client is identified by, which behind a proxy means the
 * `trustProxy` security setting has to be on for this to see anything but the proxy.
 *
 * Attempts are counted whether or not they succeed. A limit on failures only would leave the endpoint
 * open to being hammered with valid credentials, and the numbers are set for a person signing in, who
 * does not come close to them.
 */
export async function limitAuthAttempts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (WIKI.config.security?.authRateLimitEnabled === false) {
    return
  }
  const verdict = await consumeWithBanMemo(`auth:${req.ip}`, authPolicy())
  if (verdict.allowed) {
    return
  }
  WIKI.models.flags.authDebug(
    `Rate limit: refused ${req.method} ${req.url} from ${req.ip}, ${verdict.retryAfter}s left of its ban.`
  )
  /*
    429 rather than 403, and with `Retry-After`: this is not a refusal to serve the client, it is the
    same answer as before with a time on it — which is what a legitimate user locked out by a shared
    address needs to be told.
  */
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many attempts. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}

/**
 * Bound credential guessing against one account, independently of the network identity the request
 * arrives with.
 *
 * {@link limitAuthAttempts} above keys its counter on `req.ip` — exactly the value `security.trustProxy`
 * governs (see `models/security.ts`). Behind a proxy that is misconfigured to trust `X-Forwarded-For`
 * unconditionally, that header is client-written, so a guesser gets a fresh bucket on every attempt just
 * by sending a different value; with `trustProxy` correctly off, every user behind the same address
 * shares one bucket instead. This is a second, independent counter keyed on the account being guessed,
 * so neither misconfiguration leaves credential guessing unbounded. It is a rate limit, not a lockout:
 * locking the account out on a threshold keyed on something the *attacker* supplies (the identifier they
 * typed) would hand them a denial-of-service against a real account for the price of a login attempt.
 *
 * Shares {@link authPolicy}'s configured max/window/ban with the IP-keyed limiter — one admin-facing
 * "how many attempts" knob, not two to keep in sync — but counts into its own `auth:user:` key
 * namespace, so neither counter can exhaust the other's budget.
 *
 * Consumed directly from `models/users.ts#login` and `#loginTFA`, not wired as a route hook the way
 * {@link limitAuthAttempts} is: only those call sites know which account an attempt names, from the
 * submitted username in `login()` or the continuation token's already-resolved user in `loginTFA()`.
 *
 * @param identifier The account being attempted against — an email address or username as submitted.
 *   Normalized (trimmed, lower-cased) before keying, so `Admin@Example.com` and `admin@example.com`
 *   share one bucket.
 */
export async function consumeAccountAuthAttempt(identifier: string): Promise<RateLimitVerdict> {
  if (WIKI.config.security?.authRateLimitEnabled === false) {
    return { allowed: true, hits: 0, retryAfter: 0 }
  }
  const key = `auth:user:${identifier.trim().toLowerCase()}`
  return WIKI.models.rateLimits.consume(key, authPolicy())
}

/**
 * Thrown by `models/users.ts#login`/`#loginTFA` when {@link consumeAccountAuthAttempt} refuses an
 * attempt. Carries the verdict's `retryAfter` so the route handler (`api/auth/site.ts`) can
 * answer with the same 429 + `Retry-After` contract {@link limitAuthAttempts} already uses for the
 * IP-keyed limiter, instead of falling through the generic `ERR_`-prefix convention's 400 — the two
 * limiters used to disagree on this (OpenProject #2361). The message stays `ERR_RATE_LIMITED` (still
 * `ERR_`-prefixed) purely for log/debug readability; callers must check `instanceof
 * AccountRateLimitedError` *before* the generic prefix check, since the message alone would still
 * match it.
 */
export class AccountRateLimitedError extends Error {
  retryAfter: number

  constructor(retryAfter: number) {
    super('ERR_RATE_LIMITED')
    this.retryAfter = retryAfter
  }
}

/**
 * The configured policy for the general API limit. See {@link authPolicy} — same fallback shape,
 * different fields.
 */
function apiPolicy(): RateLimitPolicy {
  const security = WIKI.config.security ?? {}
  const max = Number(security.apiRateLimitMax)
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : API_DEFAULTS.max,
    windowSeconds: durationToSeconds(security.apiRateLimitWindow, API_DEFAULTS.windowSeconds),
    banSeconds: durationToSeconds(security.apiRateLimitBan, API_DEFAULTS.banSeconds)
  }
}

/**
 * Refuse a request anywhere under `/_api` once its caller has made too many, regardless of endpoint.
 *
 * Wired as a single global `onRequest` hook scoped to `/_api/*` in `index.ts`, registered after the
 * API-key-auth hook so `req.apiKey` is already populated. Unlike {@link limitAuthAttempts} and
 * {@link limitRenders}, which are opted into per-route, this one applies broadly — it is the ceiling
 * behind every API endpoint rather than a defense for one specific attack shape.
 *
 * The key identifies the caller as specifically as the request allows, so that one API key, one
 * signed-in user, or one anonymous address each gets its own counter rather than sharing whichever is
 * checked first:
 *
 *   - `apiKey:<id>` when the request carries a verified API key
 *   - `user:<id>` when it is cookie-authenticated
 *   - `ip:<address>` otherwise
 *
 * `manage:system` is exempt, checked against both `req.apiKey?.permissions` and
 * `req.session?.permissions` — the same OR the permission hook in `index.ts` resolves its single
 * `permissions` list from, kept here as two separate checks since either identity granting it is
 * enough.
 *
 * Deliberately NOT exempting the endpoints {@link limitAuthAttempts} already guards (`/login`, 2FA,
 * password reset, passkey ceremonies, page unlock): this hook and that one count into different keyed
 * buckets (`api:` / `apiKey:` / `user:` / `ip:` vs `auth:<ip>`), so nothing is double-counted against
 * the same counter, and the two serve different purposes. `limitAuthAttempts` is deliberately tight
 * and per-address because the request there IS the guess; this hook is a much looser, per-caller
 * ceiling meant to catch a client running away across the API as a whole. Because its threshold is
 * always the looser of the two (see {@link API_DEFAULTS} vs {@link AUTH_DEFAULTS}), it never trips
 * before the auth-specific limiter does on those routes — it only adds a backstop against a caller
 * spreading abusive traffic across many different endpoints, auth included.
 */
export async function limitApiRequests(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (WIKI.config.security?.apiRateLimitEnabled === false) {
    return
  }
  if (
    req.apiKey?.permissions?.includes('manage:system') ||
    req.session?.permissions?.includes('manage:system')
  ) {
    return
  }
  const key = req.apiKey
    ? `apiKey:${req.apiKey.id}`
    : req.session?.authenticated
      ? `user:${req.session.user!.id}`
      : `ip:${req.ip}`
  const verdict = await consumeWithBanMemo(`api:${key}`, apiPolicy())
  if (verdict.allowed) {
    return
  }
  WIKI.logger.warn('auth', 'rate limit refused', {
    method: req.method,
    url: req.url,
    key,
    retryAfter: verdict.retryAfter
  })
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many requests. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}

/**
 * Defaults for the root-mounted public surface's limit, used until an administrator saves their own
 * and whenever a stored value is missing or unusable.
 *
 * These are the handful of routes registered outside `/_api/` that carried no throttle of any kind
 * before this limiter existed (OpenProject #2274): `/sitemap.xml` and `/robots.txt`
 * (`controllers/seo.ts`), `/_icons`, `/_files`, `/_thumb` and `/_site`. Looser again than
 * {@link API_DEFAULTS}: none of these carry a session or an API key by default (a crawler, a plain
 * `<img>` request, an Iconify-speaking client), the traffic they see is legitimately bursty — a
 * page's whole icon batch, a folder of thumbnails — and the goal is only to stop a single client from
 * running away, not to bound ordinary use the way the authenticated API surface is.
 */
const PUBLIC_DEFAULTS: RateLimitPolicy = {
  max: 600,
  windowSeconds: 300,
  banSeconds: 900
}

/**
 * Refuse a request to a root-mounted public route once its caller has made too many.
 *
 * Wired as a second, separately-accounted `onRequest` hook in `index.ts`, scoped to the handful of
 * paths named above rather than to `/_api/*`. Shares {@link limitApiRequests}'s enable/disable
 * switch (`security.apiRateLimitEnabled`) and its `manage:system` exemption, since both are facets of
 * the same "is rate limiting on, and is this caller exempt from it" decision — but keys into its own
 * `public:` bucket with its own, looser policy, so a burst against one surface never eats into the
 * other's budget.
 *
 * No `req.apiKey` check: the API-key-auth hook only ever populates it for `/_api/*` requests, so a
 * root-mounted public route never carries one to ask about.
 */
export async function limitPublicRequests(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (WIKI.config.security?.apiRateLimitEnabled === false) {
    return
  }
  if (req.session?.permissions?.includes('manage:system')) {
    return
  }
  const key = req.session?.authenticated ? `user:${req.session.user!.id}` : `ip:${req.ip}`
  const verdict = await WIKI.models.rateLimits.consume(`public:${key}`, PUBLIC_DEFAULTS)
  if (verdict.allowed) {
    return
  }
  WIKI.logger.warn('auth', 'rate limit refused', {
    method: req.method,
    url: req.url,
    key,
    retryAfter: verdict.retryAfter
  })
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many requests. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}

/**
 * Whether a request path is one of the root-mounted public routes {@link limitPublicRequests} guards.
 *
 * Takes the path alone (query string already stripped by the caller), matching prefix-registered
 * controllers (`/_icons`, `/_files`, `/_thumb`, `/_site`) by prefix and the two bare root files
 * (`/sitemap.xml`, `/robots.txt`) exactly.
 */
export function isPublicRateLimitedPath(path: string): boolean {
  if (path === '/sitemap.xml' || path === '/robots.txt') {
    return true
  }
  return ['/_icons', '/_files', '/_thumb', '/_site'].some((prefix) => path.startsWith(`${prefix}/`))
}

/**
 * Refuse a request to render a page once a client has made too many.
 *
 * Written as a per-route `preHandler` hook — `{ preHandler: limitRenders, schema: … }` — so that the
 * route it guards says so where it is declared. It runs after the session is decoded, which is what
 * lets it count per user rather than per address: the endpoint needs a session, and unlike a password
 * guess the cost is the caller's own, so an office behind a single address should not share a limit the
 * way password guessers are made to.
 *
 * `manage:system` is exempt, as it is everywhere. Re-rendering every page after a markdown config
 * change is an operator's job, and a root admin who wants the server busy has easier ways.
 */
export async function limitRenders(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.session?.permissions?.includes('manage:system')) {
    return
  }
  const verdict = await consumeWithBanMemo(
    `render:${req.session?.user?.id ?? req.ip}`,
    RENDER_LIMIT
  )
  if (verdict.allowed) {
    return
  }
  WIKI.logger.warn('auth', 'rate limit refused', {
    method: req.method,
    url: req.url,
    ip: req.ip,
    retryAfter: verdict.retryAfter
  })
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many render requests. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}

/**
 * The limit on every request an API key makes, summed across all `/_api/` endpoints it hits.
 *
 * Not configurable per key: `apiKeys` has no per-row policy storage (the `scope` column added
 * alongside this feature narrows *what* a key may do, and says nothing about *how often*), so this
 * is a single fixed default shared by every key, modeled on `RENDER_LIMIT`'s shape rather than
 * `AUTH_DEFAULTS`'s admin-configurable one. A future per-key override — raising or lowering this for
 * one key specifically — is explicitly deferred, not designed away: it would need its own column on
 * `apiKeys` (or a reuse of `scope`'s jsonb pattern) plus admin UI, and neither exists yet. 300 in
 * five minutes is generous for a legitimate integration's steady traffic while still bounding what a
 * single leaked key can do against the whole API in that window.
 */
const API_KEY_LIMIT: RateLimitPolicy = {
  max: 300,
  windowSeconds: 300,
  banSeconds: 900
}

/**
 * Refuse a request bearing an API key once that key has made too many, across every endpoint it hits.
 *
 * Wired directly into the onRequest API-key-auth hook in `index.ts`, immediately after `req.apiKey`
 * is populated — not attached per-route like `limitAuthAttempts`/`limitRenders` above. What this
 * protects against is a compromised key, and a compromised key is exactly as dangerous on an endpoint
 * nobody thought to attach a limiter to as on one that has one; the only place that catches it
 * everywhere is the hook every bearer-token request already passes through.
 *
 * Keyed by the key's id, not by `req.ip`: the credential is what is being bounded, not the address it
 * arrives from. A legitimate integration typically calls from one stable, shared address, so an
 * IP-keyed limit here would either sit too loose to matter or punish every other key that happens to
 * share it.
 *
 * Deliberately carries no `manage:system` exemption, unlike `limitRenders`. That exemption exists
 * there because a root admin driving renders is doing legitimate, expensive operator work. Here the
 * calculus is the opposite: a key whose resolved permissions include `manage:system` is the single
 * highest-value credential in the system, and it is exactly the case this limiter has to hold —
 * exempting it would mean the API key most worth stealing is also the one this protection does
 * nothing for.
 */
export async function limitApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.apiKey) {
    return
  }
  const verdict = await consumeWithBanMemo(`apikey:${req.apiKey.id}`, API_KEY_LIMIT)
  if (verdict.allowed) {
    return
  }
  WIKI.logger.warn('auth', 'rate limit refused', {
    method: req.method,
    url: req.url,
    apiKey: req.apiKey.id,
    retryAfter: verdict.retryAfter
  })
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many requests for this API key. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}

/**
 * The limit on comments an anonymous (guest) poster may create, across every page and site.
 *
 * Not configurable, same reasoning as {@link API_KEY_LIMIT}: this is a floor against a script
 * flooding the guest comment form, not a policy an operator has a reason to tune per-deployment. Five
 * in ten minutes is far more than a real person leaving a comment or two needs, and well short of
 * what a scripted flood would attempt.
 */
const COMMENT_GUEST_LIMIT: RateLimitPolicy = {
  max: 5,
  windowSeconds: 600,
  banSeconds: 900
}

/**
 * Refuse a guest comment once its poster's address has made too many.
 *
 * This is the abuse-tracking use `req.ip` (stored per-comment as `guestIp` — see
 * `models/comments.ts#create`) was captured for: `api/comments.ts`'s POST handler calls this
 * directly, only on the anonymous branch, immediately before `WIKI.models.comments.create()` — an
 * authenticated poster is excluded, both because they already sit behind {@link limitApiRequests}'s
 * broader per-user ceiling and because their identity is already known, unlike an anonymous poster's
 * (OpenProject #2256).
 *
 * Keyed by `req.ip` alone (not per-page or per-site): one flooding script working through many pages
 * is one abuser, and splitting its count per page would let it multiply the limit by how many pages
 * it targets.
 */
export async function limitGuestComments(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const verdict = await WIKI.models.rateLimits.consume(
    `comment-guest:${req.ip}`,
    COMMENT_GUEST_LIMIT
  )
  if (verdict.allowed) {
    return
  }
  WIKI.logger.warn('auth', 'rate limit refused a guest comment', {
    method: req.method,
    url: req.url,
    ip: req.ip,
    retryAfter: verdict.retryAfter
  })
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many comments. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}
