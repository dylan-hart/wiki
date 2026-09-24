/**
 * Not a strategy id: the `users.auth` key recording which providers have been disconnected from the
 * account (strategy id → when), so a `trustEmailForLinking` login cannot quietly bind a disconnected
 * identity straight back by its address — see `models/login.ts#findOrCreateProviderUser()`.
 * `models/userCredentials.ts#unlinkStrategy()` is its only writer, and `linkStrategy()` there — the
 * explicit connect flow — the only thing that clears an entry. It lives in `users.auth` so both
 * happen in the same locked write as the link itself. Every reader walking the column as strategy
 * entries goes through {@link strategyEntries}.
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

/**
 * Whether one stored `auth` entry is, right now, a way into the account. Its strategy has to be
 * enabled and loaded: a disabled strategy has no `CARDINAL.auth.strategies` instance and its
 * authorize route answers 404, and deleting a strategy leaves every account's entry for it behind.
 * An entry that is itself restricted is no way in either, and nor is a password the account holder
 * does not know — the random one `users.createUser()` writes for an account a provider
 * auto-provisioned, stored as `isPasswordKnown: false`.
 */
function isUsableLogin(strategyId: string, entry: any): boolean {
  if (!CARDINAL.auth?.strategies?.[strategyId]) {
    return false
  }
  return !entry?.restrictLogin && (!entry?.password || entry.isPasswordKnown === true)
}

/**
 * How many of the account's stored sign-in methods are {@link isUsableLogin} right now, leaving out
 * `exceptStrategyId` when one is named. Passkeys live in their own column and are the caller's to
 * add: `models/userCredentials.ts#countAlternativeLogins()` adds them, and
 * `models/security.ts#checkPasskeyLockout()` asks what is left without them.
 */
export function countUsableStrategyLogins(auth: unknown, exceptStrategyId?: string): number {
  return strategyEntries(auth).filter(
    ([id, entry]) => id !== exceptStrategyId && isUsableLogin(id, entry)
  ).length
}
