/**
 * Boot-time guard for `WIKI.config.auth.secret`.
 *
 * The value signs both the session cookie (`@fastify/cookie`) and the session itself
 * (`@fastify/session`), registered in `index.ts#initHTTPServer()` — its entire purpose is
 * unguessability. Historically the shipped default in `base.yml` was a publicly-known string,
 * overwritten only once `preBoot()`'s `loadFromDb()` overlays the real secret
 * `models/settings.ts#init()` seeds on first run. That ordering has always been correct, but
 * nothing asserted it: a future regression reordering boot, or a code path that skips
 * `loadFromDb()`, would silently register the session plugins with a well-known secret instead
 * of failing to boot. `base.yml` no longer ships any `auth.secret` default at all (there's
 * nothing for the merge to fall back to), so this guard is the only thing standing between a
 * missing/short secret and a running server.
 */
export function assertValidAuthSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error(
      'WIKI.config.auth.secret is missing or shorter than 32 bytes -- refusing to register the session/cookie plugins with an unguessable secret. This should only happen if the settings row failed to load or seed correctly.'
    )
  }
}
