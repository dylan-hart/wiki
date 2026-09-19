import fastifyCookie from '@fastify/cookie'

/**
 * `@fastify/cookie` and `@fastify/session` hash a raw `secret` into a `Signer` once at registration,
 * but call a `{ sign, unsign }` object per request. Reading `CARDINAL.config.auth.secret` at call
 * time is therefore what lets a secret rotation — `models/sessions.ts#rotateSecret()` here, or
 * `core/config.ts#loadFromDb()` replacing `CARDINAL.config` on the other instances — take effect on
 * the next request rather than the next restart.
 */
export const authSecretSigner = {
  sign(value: string): string {
    return fastifyCookie.sign(value, CARDINAL.config.auth.secret)
  },
  unsign(value: string): fastifyCookie.UnsignResult {
    return fastifyCookie.unsign(value, CARDINAL.config.auth.secret)
  }
}
