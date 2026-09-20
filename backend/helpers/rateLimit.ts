import { LRUCache } from 'lru-cache'
import { coalesce } from './logCoalesce.ts'
import { durationToSeconds } from './common.ts'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { RateLimitPolicy, RateLimitVerdict } from '../models/rateLimits.ts'
/**
 * In-process memo of currently-banned keys, so a key already serving a ban is refused without
 * `CARDINAL.models.rateLimits.consume()`'s UPDATE against the same hot row on every request.
 *
 * Refusal-only: an allowed verdict is never memoized. The counter itself must stay database-backed
 * so instances behind a load balancer agree, and a grant-side cache could keep answering "allowed"
 * after another instance banned the key. A memoized refusal expires with the ban (`retryAfter`).
 *
 * Exported so tests can `.clear()` it between cases that reuse a key.
 */
export const activeBanMemo = new LRUCache<string, number>({
  max: 5000,
  // lru-cache reuses one clock reading for `ttlResolution` ms (default 1); 0 keeps the
  // `Retry-After` recomputed from `getRemainingTTL` exact, and this is never hot enough to matter.
  ttlResolution: 0
})

/**
 * `CARDINAL.models.rateLimits.consume()`, fronted by {@link activeBanMemo}. A memoized refusal
 * recomputes `retryAfter` from the entry's remaining TTL so it counts down; the memoized `hits`
 * stays accurate because a banned key stops counting.
 */
async function consumeWithBanMemo(key: string, policy: RateLimitPolicy): Promise<RateLimitVerdict> {
  const memoizedHits = activeBanMemo.get(key)
  if (memoizedHits !== undefined) {
    const retryAfter = Math.max(1, Math.ceil(activeBanMemo.getRemainingTTL(key) / 1000))
    return { allowed: false, hits: memoizedHits, retryAfter }
  }
  const verdict = await CARDINAL.models.rateLimits.consume(key, policy)
  if (!verdict.allowed && verdict.retryAfter > 0) {
    activeBanMemo.set(key, verdict.hits, { ttl: verdict.retryAfter * 1000 })
  }
  return verdict
}

/**
 * A banned client hammering an endpoint gets its first few refusals logged in full through
 * `logIndividual`, and the rest as one summary per window.
 *
 * `coalesceKey` must be namespaced per limiter AND per client, or unrelated refusals share one
 * summary window.
 */
function logRefusal(
  coalesceKey: string,
  windowMs: number,
  message: string,
  clientFields: Record<string, unknown>,
  logIndividual: () => void
): void {
  const logInFull = coalesce(coalesceKey, windowMs, (summary) => {
    CARDINAL.logger.warn(
      'auth',
      `${message} ${summary.total} times in ${Math.round(summary.windowMs / 1000)}s`,
      { ...clientFields, count: summary.total }
    )
  })
  if (logInFull) {
    logIndividual()
  }
}

/**
 * Fallback for the authentication limit when a stored value is missing or unusable: far more than
 * a person signing in needs, far less than guessing a password takes.
 */
const AUTH_DEFAULTS: RateLimitPolicy = {
  max: 10,
  windowSeconds: 300,
  banSeconds: 900
}

/**
 * Fallback for the general API limit. Looser than {@link AUTH_DEFAULTS}: it guards against a
 * runaway client, not credential guessing, and legitimate bulk use (a paging script, a scheduled
 * sync) needs headroom.
 */
const API_DEFAULTS: RateLimitPolicy = {
  max: 300,
  windowSeconds: 300,
  banSeconds: 900
}

/**
 * Not configurable: it protects the host rather than a secret. The render queue settles how many
 * browsers run at once; this only keeps one client from filling that queue faster than it drains.
 *
 * Exported for the MCP diagram-render tool, which has no Fastify `req`/`reply` to hang
 * {@link limitRenders} off but runs the same Puppeteer-backed operation.
 */
export const RENDER_LIMIT: RateLimitPolicy = {
  max: 10,
  windowSeconds: 300,
  banSeconds: 300
}

/**
 * Every field falls back on its own, so one unusable value leaves the rest of the limit standing
 * rather than turning it off. Durations are stored as the operator wrote them (`5m`, `15m`, `1d`).
 */
function authPolicy(): RateLimitPolicy {
  const security = CARDINAL.config.security ?? {}
  const max = Number(security.authRateLimitMax)
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : AUTH_DEFAULTS.max,
    windowSeconds: durationToSeconds(security.authRateLimitWindow, AUTH_DEFAULTS.windowSeconds),
    banSeconds: durationToSeconds(security.authRateLimitBan, AUTH_DEFAULTS.banSeconds)
  }
}

/**
 * Exported so `models/login.ts` coalesces its refusal lines over the same window without keeping a
 * second copy of {@link authPolicy}'s fallback rules.
 */
export function authRateLimitWindowMs(): number {
  return authPolicy().windowSeconds * 1000
}

/**
 * Namespaced away from `models/login.ts`'s `auth:login-refused:` keys, so bans and refusals
 * summarise independently.
 */
function banLogKey(ip: string): string {
  return `auth:rate-limit-banned:${ip}`
}

/**
 * A per-route `onRequest` hook, so it runs before the body is parsed. It belongs on the routes
 * where the request IS the guess: sign-in, a second factor, a password change from the login
 * screen, a passkey ceremony, a page unlock.
 *
 * One counter per client address across all of them: splitting it per endpoint would give an
 * attacker the limit once per endpoint. Behind a proxy, `req.ip` is only the client when the
 * `trustProxy` security setting is on.
 *
 * Successful attempts count too: a failures-only limit would leave the endpoint open to being
 * hammered with valid credentials.
 */
export async function limitAuthAttempts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (CARDINAL.config.security?.authRateLimitEnabled === false) {
    return
  }
  const verdict = await consumeWithBanMemo(`auth:${req.ip}`, authPolicy())
  if (verdict.allowed) {
    return
  }
  // A banned key is refused on every request it keeps making, so this line is coalesced. `hits`
  // is the count the ban was decided on.
  const ip = req.ip
  const windowMs = authRateLimitWindowMs()
  const logInFull = coalesce(banLogKey(ip), windowMs, (summary) => {
    CARDINAL.logger.warn(
      'auth',
      `rate limit banned ${summary.total} times in ${Math.round(summary.windowMs / 1000)}s`,
      { ip }
    )
  })
  if (logInFull) {
    CARDINAL.logger.warn('auth', 'rate limit banned', {
      method: req.method,
      url: req.url,
      ip,
      hits: verdict.hits,
      retryAfter: verdict.retryAfter
    })
  }
  // 429 with `Retry-After`, not 403: a legitimate user locked out by a shared address needs to be
  // told when to come back.
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many attempts. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}

/**
 * {@link limitAuthAttempts} keys on `req.ip`, which `security.trustProxy` governs: a proxy trusting
 * a client-written `X-Forwarded-For` hands a guesser a fresh bucket per attempt. This second
 * counter is keyed on the account being guessed, so that misconfiguration does not leave guessing
 * unbounded. A rate limit, not a lockout: locking an account on a threshold keyed on what the
 * attacker typed would hand them a denial-of-service against it.
 *
 * Shares {@link authPolicy} with the IP-keyed limiter but counts under its own `auth:user:` keys,
 * so neither exhausts the other's budget. Called from `models/login.ts` rather than wired as a
 * route hook: only there is the account an attempt names known.
 */
export async function consumeAccountAuthAttempt(identifier: string): Promise<RateLimitVerdict> {
  if (CARDINAL.config.security?.authRateLimitEnabled === false) {
    return { allowed: true, hits: 0, retryAfter: 0 }
  }
  const key = `auth:user:${identifier.trim().toLowerCase()}`
  return CARDINAL.models.rateLimits.consume(key, authPolicy())
}

/**
 * Carries `retryAfter` so a route handler can answer 429 + `Retry-After`, as
 * {@link limitAuthAttempts} does. Handlers must check `instanceof` BEFORE their generic
 * `ERR_`-prefix branch, which this message also matches and which would answer 400.
 */
export class AccountRateLimitedError extends Error {
  retryAfter: number

  constructor(retryAfter: number) {
    super('ERR_RATE_LIMITED')
    this.retryAfter = retryAfter
  }
}

function apiPolicy(): RateLimitPolicy {
  const security = CARDINAL.config.security ?? {}
  const max = Number(security.apiRateLimitMax)
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : API_DEFAULTS.max,
    windowSeconds: durationToSeconds(security.apiRateLimitWindow, API_DEFAULTS.windowSeconds),
    banSeconds: durationToSeconds(security.apiRateLimitBan, API_DEFAULTS.banSeconds)
  }
}

/**
 * The ceiling behind every `/_api` endpoint, keyed as specifically as the request allows (API key,
 * else signed-in user, else address) so each caller gets its own counter. Needs `req.apiKey`
 * populated, so its hook must run after the API-key-auth hook.
 *
 * The endpoints {@link limitAuthAttempts} guards are deliberately not exempt: the two count under
 * different keys (`api:` vs `auth:`), so nothing is counted twice, and this one also backstops a
 * caller spreading abusive traffic across many endpoints, auth included.
 */
export async function limitApiRequests(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (CARDINAL.config.security?.apiRateLimitEnabled === false) {
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
  const policy = apiPolicy()
  const verdict = await consumeWithBanMemo(`api:${key}`, policy)
  if (verdict.allowed) {
    return
  }
  logRefusal(
    `api:refused:${key}`,
    policy.windowSeconds * 1000,
    'rate limit refused',
    { key },
    () => {
      CARDINAL.logger.warn('auth', 'rate limit refused', {
        method: req.method,
        url: req.url,
        key,
        retryAfter: verdict.retryAfter
      })
    }
  )
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many requests. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}

/**
 * The limit on the root-mounted public routes ({@link isPublicRateLimitedPath}). Fixed, not
 * admin-configurable, and looser than {@link API_DEFAULTS}: their traffic is legitimately bursty (a
 * page's whole icon batch, a folder of thumbnails), and this only stops a client running away.
 */
const PUBLIC_DEFAULTS: RateLimitPolicy = {
  max: 600,
  windowSeconds: 300,
  banSeconds: 900
}

/**
 * Shares {@link limitApiRequests}'s `security.apiRateLimitEnabled` switch and `manage:system`
 * exemption, but counts under its own `public:` keys so a burst on one surface never eats the
 * other's budget.
 */
export async function limitPublicRequests(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (CARDINAL.config.security?.apiRateLimitEnabled === false) {
    return
  }
  if (req.session?.permissions?.includes('manage:system')) {
    return
  }
  const key = req.session?.authenticated ? `user:${req.session.user!.id}` : `ip:${req.ip}`
  const verdict = await CARDINAL.models.rateLimits.consume(`public:${key}`, PUBLIC_DEFAULTS)
  if (verdict.allowed) {
    return
  }
  logRefusal(
    `public:refused:${key}`,
    PUBLIC_DEFAULTS.windowSeconds * 1000,
    'rate limit refused',
    { key },
    () => {
      CARDINAL.logger.warn('auth', 'rate limit refused', {
        method: req.method,
        url: req.url,
        key,
        retryAfter: verdict.retryAfter
      })
    }
  )
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many requests. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}

/** `path` must already have its query string stripped: the two root files are matched exactly. */
export function isPublicRateLimitedPath(path: string): boolean {
  if (path === '/sitemap.xml' || path === '/robots.txt') {
    return true
  }
  return ['/_icons', '/_files', '/_thumb', '/_site'].some((prefix) => path.startsWith(`${prefix}/`))
}

/**
 * A per-route `preHandler`, not `onRequest`: it runs after the session is decoded, so it can count
 * per user. Unlike password guessers, an office behind one address should not share a render limit.
 *
 * `manage:system` is exempt: re-rendering every page after a markdown config change is an
 * operator's job.
 */
export async function limitRenders(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.session?.permissions?.includes('manage:system')) {
    return
  }
  const renderKey = req.session?.user?.id ?? req.ip
  const verdict = await consumeWithBanMemo(`render:${renderKey}`, RENDER_LIMIT)
  if (verdict.allowed) {
    return
  }
  logRefusal(
    `render:refused:${renderKey}`,
    RENDER_LIMIT.windowSeconds * 1000,
    'rate limit refused',
    { ip: req.ip },
    () => {
      CARDINAL.logger.warn('auth', 'rate limit refused', {
        method: req.method,
        url: req.url,
        ip: req.ip,
        retryAfter: verdict.retryAfter
      })
    }
  )
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many render requests. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}

/**
 * The limit on the single-file upload routes, tighter than and independent of the `/_api` ceiling
 * they also sit behind. Not configurable: it is a floor against one abuse shape. Real bulk uploads
 * go through the batch endpoints, so a rapid burst of single-file requests is a script working
 * around the batch endpoints' per-request file-count cap.
 */
const UPLOAD_LIMIT: RateLimitPolicy = {
  max: 20,
  windowSeconds: 300,
  banSeconds: 300
}

/**
 * Keyed like {@link limitRenders}: by session user, else address. As a `preHandler` it runs ahead
 * of any authorization a route does inside its handler, so a caller about to be refused still
 * consumes budget rather than getting a free pass.
 */
export async function limitUploads(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.session?.permissions?.includes('manage:system')) {
    return
  }
  const key = req.session?.user?.id ?? req.ip
  const verdict = await consumeWithBanMemo(`upload:${key}`, UPLOAD_LIMIT)
  if (verdict.allowed) {
    return
  }
  logRefusal(
    `upload:refused:${key}`,
    UPLOAD_LIMIT.windowSeconds * 1000,
    'rate limit refused an upload',
    { key },
    () => {
      CARDINAL.logger.warn('auth', 'rate limit refused an upload', {
        method: req.method,
        url: req.url,
        key,
        retryAfter: verdict.retryAfter
      })
    }
  )
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many uploads. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}

/**
 * One fixed limit on everything an API key does, shared by every key: `apiKeys` stores no per-key
 * policy. Generous for an integration's steady traffic, while bounding what a leaked key can do.
 */
const API_KEY_LIMIT: RateLimitPolicy = {
  max: 300,
  windowSeconds: 300,
  banSeconds: 900
}

/**
 * Bounds a compromised key, so it is called wherever a bearer token is verified rather than
 * attached per route: a stolen key is as dangerous on an endpoint nobody attached a limiter to.
 *
 * Keyed by the key's id, not `req.ip`: integrations often share one stable address, so an IP-keyed
 * limit would punish every other key behind it.
 *
 * Deliberately no `manage:system` exemption, unlike the other limiters: a key holding it is the
 * credential most worth stealing, and the one this most has to hold for.
 */
export async function limitApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.apiKey) {
    return
  }
  const apiKeyId = req.apiKey.id
  const verdict = await consumeWithBanMemo(`apikey:${apiKeyId}`, API_KEY_LIMIT)
  if (verdict.allowed) {
    return
  }
  logRefusal(
    `apikey:refused:${apiKeyId}`,
    API_KEY_LIMIT.windowSeconds * 1000,
    'rate limit refused',
    { apiKey: apiKeyId },
    () => {
      CARDINAL.logger.warn('auth', 'rate limit refused', {
        method: req.method,
        url: req.url,
        apiKey: apiKeyId,
        retryAfter: verdict.retryAfter
      })
    }
  )
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many requests for this API key. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}

/**
 * Not configurable: a floor against a script flooding the guest comment form, far above what a
 * person leaving a comment or two needs.
 */
const COMMENT_GUEST_LIMIT: RateLimitPolicy = {
  max: 5,
  windowSeconds: 600,
  banSeconds: 900
}

/**
 * For anonymous posters only: the caller decides that, not this limiter. Keyed by `req.ip` alone,
 * not per page or site, or a script working through many pages multiplies the limit by page count.
 */
export async function limitGuestComments(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const verdict = await CARDINAL.models.rateLimits.consume(
    `comment-guest:${req.ip}`,
    COMMENT_GUEST_LIMIT
  )
  if (verdict.allowed) {
    return
  }
  logRefusal(
    `comment-guest:refused:${req.ip}`,
    COMMENT_GUEST_LIMIT.windowSeconds * 1000,
    'rate limit refused a guest comment',
    { ip: req.ip },
    () => {
      CARDINAL.logger.warn('auth', 'rate limit refused a guest comment', {
        method: req.method,
        url: req.url,
        ip: req.ip,
        retryAfter: verdict.retryAfter
      })
    }
  )
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many comments. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}

/**
 * Enforce the native comment provider's admin-configured `minDelay` between comments, for guests
 * and accounts alike. The caller decides whether it applies (`minDelay > 0`, no `manage:comments`)
 * and resolves `bucketKey`: the poster's account id, or one pooled bucket for all guests — never a
 * raw `req.ip`.
 *
 * `banSeconds` must equal the delay, not `0`: with `max: 1`, a zero-length ban lands exactly on
 * `consume()`'s own `now()`, which its `bannedUntil > now()` reads back as "not banned", and the
 * next call then rolls the window over as though nothing had been posted.
 */
export async function enforceCommentCooldown(
  req: FastifyRequest,
  reply: FastifyReply,
  bucketKey: string,
  minDelaySeconds: number
): Promise<void> {
  const verdict = await CARDINAL.models.rateLimits.consume(`comment-cooldown:${bucketKey}`, {
    max: 1,
    windowSeconds: minDelaySeconds,
    banSeconds: minDelaySeconds
  })
  if (verdict.allowed) {
    return
  }
  logRefusal(
    `comment-cooldown:refused:${bucketKey}`,
    minDelaySeconds * 1000,
    'rate limit refused a comment (post delay)',
    { bucket: bucketKey },
    () => {
      CARDINAL.logger.warn('auth', 'rate limit refused a comment (post delay)', {
        method: req.method,
        url: req.url,
        bucket: bucketKey,
        retryAfter: verdict.retryAfter
      })
    }
  )
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Please wait ${verdict.retryAfter} second(s) before commenting again.`
  )
}
