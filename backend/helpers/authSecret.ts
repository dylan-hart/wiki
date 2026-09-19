/**
 * `CARDINAL.config.auth.secret` signs the session cookie (`@fastify/cookie`) and the session itself
 * (`@fastify/session`), and `base.yml` ships no default for it: the value comes only from the row
 * `models/settings.ts#init()` seeds, overlaid by `preBoot()`'s `loadFromDb()`. Called from
 * `index.ts#initHTTPServer()` so a boot that reordered those steps fails loudly rather than signing
 * with nothing.
 */
export function assertValidAuthSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error(
      'CARDINAL.config.auth.secret is missing or shorter than 32 bytes -- refusing to register the session/cookie plugins with an unguessable secret. This should only happen if the settings row failed to load or seed correctly.'
    )
  }
}
