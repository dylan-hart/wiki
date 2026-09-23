/**
 * Not a strategy id: the `users.auth` key recording which providers have been disconnected from the
 * account (strategy id → when), so a `trustEmailForLinking` login cannot quietly bind a disconnected
 * identity straight back by its address — see `models/login.ts#findOrCreateProviderUser()`.
 * `models/userCredentials.ts#unlinkStrategy()` is its only writer, and `linkStrategy()` there — the
 * explicit connect flow — the only thing that clears an entry. It lives in `users.auth` so both
 * happen in the same locked write as the link itself. Every reader walking the column as strategy
 * entries goes through {@link strategyEntries}; `models/security.ts#checkPasskeyLockout()`'s SQL
 * skips it by name.
 */
export const DISCONNECTED_AUTH_KEY = 'disconnected'

/** `users.auth` as `[strategyId, entry]` pairs, without {@link DISCONNECTED_AUTH_KEY}. */
export function strategyEntries(auth: unknown): Array<[string, any]> {
  return Object.entries((auth ?? {}) as Record<string, any>).filter(
    ([key]) => key !== DISCONNECTED_AUTH_KEY
  )
}

/** Whether this provider was disconnected from the account and not connected again since. */
export function isDisconnected(user: { auth?: unknown }, strategyId: string): boolean {
  return Boolean(((user.auth ?? {}) as Record<string, any>)[DISCONNECTED_AUTH_KEY]?.[strategyId])
}
