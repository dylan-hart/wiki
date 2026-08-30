import fastifyCookie from '@fastify/cookie'

/**
 * A `@fastify/cookie` / `@fastify/session` signer that reads `WIKI.config.auth.secret` fresh on
 * every call, instead of the secret being captured by value once at plugin registration.
 *
 * Both plugins accept `secret` as either a raw value (string/array) — hashed into a `Signer`
 * instance ONCE, at registration — or an object shaped like `{ sign, unsign }`, used as-is and
 * called on every request. Handing them this object is what makes `models/sessions.ts#rotateSecret()`
 * take effect on a still-running instance immediately: `sign()`/`unsign()` below read
 * `WIKI.config.auth.secret` at call time, so the moment `WIKI.config` is replaced — either by
 * `rotateSecret()` on this instance, or by `core/config.ts#loadFromDb()` reassigning it in response to
 * the `reloadConfig` event `rotateSecret()`'s `saveToDb()` fans out to every other instance — the very
 * next request signs and verifies against the new secret, with no restart. Mirrors the same
 * read-fresh-on-every-call pattern `models/apiKeys.ts#verify()` already uses for `auth.certs.public`.
 *
 * Delegates the actual HMAC work to `@fastify/cookie`'s own exported `sign`/`unsign` functions
 * (`fastifyCookie.sign(value, secret)`), rather than re-implementing cookie signing here.
 */
export const authSecretSigner = {
  sign(value: string): string {
    return fastifyCookie.sign(value, WIKI.config.auth.secret)
  },
  unsign(value: string): fastifyCookie.UnsignResult {
    return fastifyCookie.unsign(value, WIKI.config.auth.secret)
  }
}
