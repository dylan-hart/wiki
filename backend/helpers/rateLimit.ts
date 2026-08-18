import { durationToSeconds } from './common.ts'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { RateLimitPolicy } from '../models/rateLimits.ts'

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
 * The limit on asking for a page to be rendered.
 *
 * Not configurable, unlike the authentication limit above: what this protects is the host rather than
 * a secret, and no deployment has a reason to raise it. How many browsers run at once is settled by
 * the render queue rather than here — this only keeps one client from filling that queue faster than
 * anything could drain it. Ten in five minutes is far more than re-rendering a stale page takes.
 */
const RENDER_LIMIT: RateLimitPolicy = {
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
  const verdict = await WIKI.models.rateLimits.consume(`auth:${req.ip}`, authPolicy())
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
  const verdict = await WIKI.models.rateLimits.consume(
    `render:${req.session?.user?.id ?? req.ip}`,
    RENDER_LIMIT
  )
  if (verdict.allowed) {
    return
  }
  WIKI.logger.debug(
    `Rate limit: refused ${req.method} ${req.url} from ${req.ip}, ${verdict.retryAfter}s left of its ban.`
  )
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
  const verdict = await WIKI.models.rateLimits.consume(`apikey:${req.apiKey.id}`, API_KEY_LIMIT)
  if (verdict.allowed) {
    return
  }
  WIKI.logger.debug(
    `Rate limit: refused ${req.method} ${req.url} for API key ${req.apiKey.id}, ${verdict.retryAfter}s left of its ban.`
  )
  reply.header('Retry-After', String(verdict.retryAfter))
  return reply.tooManyRequests(
    `Too many requests for this API key. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
  )
}
