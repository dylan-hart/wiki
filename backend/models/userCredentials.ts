import bcrypt from 'bcryptjs'
import QRCode from 'qrcode'
import {
  authentication as authenticationTable,
  users as usersTable,
  userKeys
} from '../db/schema.ts'
import { eq, lt, sql } from 'drizzle-orm'
import type { WikiDbOrTx } from '../core/db.ts'
import { nanoid } from 'nanoid'
import { BCRYPT_ROUNDS } from '../helpers/common.ts'
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from '../helpers/totp.ts'
import { withAdvisoryLock } from '../helpers/advisoryLock.ts'
import { generateRecoveryCodes, normalizeRecoveryCode } from '../helpers/recoveryCodes.ts'

/**
 * An authentication provider linked to a user, as exposed by the API. Secrets held in the stored
 * `auth` blob (the password hash, the TFA secret) are never included — `isPasswordSet` and
 * `isTfaSetup` report their state instead.
 */
export interface UserAuthProvider {
  authId: string
  authName: string
  strategyKey: string
  strategyIcon: string
  config: Record<string, any>
}

/**
 * One authentication provider as the user's own profile page sees it: enough to render what can be
 * done with it, and nothing else. Unlike the administrator's view this carries no provider flags —
 * only whether a password exists, whether 2FA is set up, and whether the user is allowed to turn it
 * off again.
 */
export interface UserProfileAuthMethod {
  authId: string
  authName: string
  strategyKey: string
  strategyIcon: string
  config: {
    isPasswordSet: boolean
    isTfaSetup: boolean
    isTfaRequired: boolean
    /** False once password login has been turned off, whether by the user or by an administrator. */
    isPasswordLoginEnabled: boolean
    /** Whether the account has another way in, and may therefore turn password login off. */
    canDisablePasswordLogin: boolean
    /** How many of the 2FA recovery codes issued for this provider are still unused. 0 when 2FA is off. */
    recoveryCodesRemaining: number
  }
}

/**
 * One issued 2FA recovery code, as stored on `auth[strategyId].recoveryCodes`. Only the hash is ever
 * kept — the plaintext is returned to the caller once, at the moment it is generated, and never
 * again. `usedAt` is set the first (and only) time the code is redeemed; a code with a value here is
 * dead and is skipped by every check from then on.
 */
export interface RecoveryCodeEntry {
  hash: string
  usedAt: string | null
}

/**
 * Advisory-lock key for serializing writes to one user's whole-blob `auth` column.
 *
 * Every read-modify-write against `users.auth` -- a password change, a TFA toggle, a recovery-code
 * redemption, a TOTP replay-counter update, ... -- reads the entire JSONB column, mutates part of it
 * in memory, and writes the entire column back with no row lock and no conditional `WHERE`. Two such
 * writes for the same user racing (an admin's `adminInvalidateTfa` against a user's own in-flight
 * `verifyAndConsumeRecoveryCode`, say) is a lost update: whichever write lands second silently
 * clobbers the first's change with a blob it read before that change existed. Every call site below
 * that touches `auth` acquires this lock, keyed by user id, for the span from its read of the current
 * row to its write of the updated one, so concurrent writers for the *same* user serialize instead of
 * racing; writers for different users are never blocked by each other.
 */
function authLockKey(userId: string): string {
  return `wiki:user-auth:${userId}`
}

/**
 * What a strategy's auth entry is patched with when 2FA is turned off: inactive, secret forgotten,
 * recovery codes thrown away — so setting it up again starts from a genuinely new secret rather than
 * silently re-arming the old one.
 *
 * Shared by `disableTfa()` (the user's own choice, refused when enforcement is on) and
 * `adminInvalidateTfa()` (an administrator overriding exactly that enforcement). The two methods stay
 * separate for the reason `adminInvalidateTfa`'s own doc comment gives — that is about who may ask,
 * not about what gets written, and what gets written is this.
 *
 * A factory rather than a shared constant: the value is merged into a stored JSON blob, and handing
 * two accounts the same `recoveryCodes` array would make them one array.
 */
function clearedTfa(): Record<string, any> {
  return { tfaIsActive: false, tfaSecret: '', recoveryCodes: [] }
}

/**
 * Count a wrong 2FA code against a continuation token, destroying the token once `maxTfaAttempts`
 * have been used up — the client then has nothing left to continue with and has to start over.
 *
 * A token that has already been destroyed, or never existed, is not an error here: the caller is
 * about to reject the attempt either way.
 */
export async function countTfaFailure(token: string): Promise<void> {
  const rows = await WIKI.db
    .select({ id: userKeys.id, meta: userKeys.meta, userId: userKeys.userId })
    .from(userKeys)
    .where(eq(userKeys.token, token))
    .limit(1)
  const row = rows[0]
  if (!row) {
    return
  }

  const meta = (row.meta ?? {}) as Record<string, any>
  const attempts = (meta.attempts ?? 0) + 1
  if (attempts >= maxTfaAttempts) {
    await WIKI.db.delete(userKeys).where(eq(userKeys.id, row.id))
    WIKI.models.flags.authDebug(
      `Discarded the 2FA continuation token of user ${row.userId} after ${attempts} incorrect codes`
    )
    return
  }
  await WIKI.db
    .update(userKeys)
    .set({ meta: { ...meta, attempts } })
    .where(eq(userKeys.id, row.id))
}

/**
 * How many wrong 2FA codes a continuation token survives before it is destroyed and the user has to
 * start the login over. Retries have to be allowed — six digits get mistyped, and a code that rotates
 * every 30 seconds is regularly entered a moment too late — but an unlimited number of them against a
 * token that lives for 24 hours is a code space small enough to walk through.
 */
const maxTfaAttempts = 5

/**
 * A fresh set of recovery codes, in both forms `enableTfa()`/`regenerateRecoveryCodes()` need: the
 * plaintext to hand back to the caller exactly once, and the hashed entries to store.
 */
async function issueRecoveryCodes(): Promise<{
  plaintext: string[]
  entries: RecoveryCodeEntry[]
}> {
  const plaintext = generateRecoveryCodes()
  const entries: RecoveryCodeEntry[] = await Promise.all(
    plaintext.map(async (code) => ({
      hash: await bcrypt.hash(normalizeRecoveryCode(code), BCRYPT_ROUNDS),
      usedAt: null
    }))
  )
  return { plaintext, entries }
}

/**
 * Which stored recovery code entry (if any) a normalized code matches. Every unconsumed entry is
 * checked, not just until the first hit — mirroring the constant-time discipline `verifyTotpCode`
 * uses for its drift window, so how long this takes does not depend on which one (if any) matched.
 * An already-consumed entry is skipped without comparison: it can never match again regardless of
 * what was typed, so there is nothing to hide by skipping it.
 *
 * Exported for direct unit testing — this is the one piece of recovery-code verification that has no
 * database or `WIKI` global in it.
 *
 * @returns The index of the matching entry, or -1
 */
export async function matchRecoveryCode(
  entries: RecoveryCodeEntry[],
  normalizedCode: string
): Promise<number> {
  let matchedIndex = -1
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.usedAt) {
      continue
    }
    if (await bcrypt.compare(normalizedCode, entries[i]!.hash)) {
      matchedIndex = i
    }
  }
  return matchedIndex
}

/**
 * How many ways into the account remain if the given provider stops working: the other providers
 * linked to it, plus every registered passkey.
 *
 * A provider that is itself restricted does not count — it is no way in either. Passkeys are counted
 * whichever host they were registered against: on a multi-site instance one bound to another site
 * still leaves the account reachable, which is what this guards against.
 */
function countAlternativeLogins(user: any, strategyId: string): number {
  const auth = (user.auth ?? {}) as Record<string, any>
  const otherProviders = Object.entries(auth).filter(
    ([id, config]) => id !== strategyId && !config?.restrictLogin
  ).length
  const passkeys = ((user.passkeys ?? {}).authenticators ?? []).length
  return otherProviders + passkeys
}

/**
 * User credentials model
 *
 * Everything a `users` row's `auth` blob and its `userKeys` tokens are made of: local passwords, the
 * 2FA lifecycle (setup, enable, disable, verify, recovery codes) and the short-lived tokens a login
 * continuation, an email verification or a password reset is carried on.
 *
 * Split out of `models/users.ts` (MOD-F12) because it is a different subject from an account itself:
 * `users` owns who exists, what they are called and which groups they are in; this owns how they
 * prove it. Both are needed by `models/login.ts`, which is the flow that puts them together.
 */
class UserCredentials {
  /**
   * The read-modify-write every `users.auth` change is made of, in one place.
   *
   * Fourteen methods — a password set or change, each 2FA transition, a recovery-code redemption, the
   * TOTP replay counter, a provider link written on login — each wrote out the same five moves:
   * take {@link authLockKey}'s per-user advisory lock, re-read the row INSIDE it (never trusting a
   * `user` the caller loaded earlier, which is the whole point of the lock — see `authLockKey`'s own
   * doc comment on the lost update this prevents), merge a patch into that strategy's entry, and
   * write the whole `auth` blob back with a bumped `updatedAt`.
   *
   * @param mutate Given this strategy's CURRENT entry (undefined when the user has none), returns the
   *   fields to merge into it — or `null` to make the whole call a no-op, which is how a redemption
   *   that finds nothing to redeem, or a replayed TOTP code, declines to write anything at all
   * @param opts.db Runs the read and the write on this handle rather than `WIKI.db`, so a caller
   *   already inside a transaction is joined rather than raced
   * @param opts.mirrorInto Copies the freshly-written blob onto a caller's own stale `user` object, so
   *   a login flow holding a row from before this write keeps reading its own change back
   * @returns Whether a write actually happened: false when the user is gone, or `mutate` declined
   */
  async patchStrategyAuth(
    userId: string,
    strategyId: string,
    mutate: (
      entry: Record<string, any> | undefined
    ) => Record<string, any> | null | Promise<Record<string, any> | null>,
    opts: { db?: WikiDbOrTx; mirrorInto?: { auth: unknown } } = {}
  ): Promise<boolean> {
    const db = opts.db ?? WIKI.db
    return withAdvisoryLock(authLockKey(userId), async () => {
      const current = await WIKI.models.users.getById(userId, db)
      if (!current) {
        return false
      }
      const currentAuth = (current.auth ?? {}) as Record<string, any>
      const patch = await mutate(currentAuth[strategyId])
      if (patch === null) {
        return false
      }
      currentAuth[strategyId] = { ...currentAuth[strategyId], ...patch }
      if (opts.mirrorInto) {
        opts.mirrorInto.auth = currentAuth
      }
      await db
        .update(usersTable)
        .set({ auth: currentAuth, updatedAt: sql`now()` })
        .where(eq(usersTable.id, userId))
      return true
    })
  }

  /**
   * The pre-flight every 2FA and password-login method makes before touching a strategy's auth entry:
   * the user exists, it actually has an entry for this strategy, and (where the caller asks) 2FA is
   * currently active on it. Six methods each wrote out the same two or three guards.
   *
   * @param opts.tfaActive Also require `tfaIsActive` on the entry
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY` or `ERR_TFA_NOT_ACTIVE`
   */
  async requireStrategyAuth(
    userId: string,
    strategyId: string,
    opts: { tfaActive?: boolean } = {}
  ): Promise<{ user: any; auth: Record<string, any>; entry: Record<string, any> }> {
    const user = await WIKI.models.users.getById(userId)
    if (!user) {
      throw new Error('ERR_INVALID_USER')
    }
    const auth = (user.auth ?? {}) as Record<string, any>
    const entry = auth[strategyId]
    if (!entry) {
      throw new Error('ERR_INVALID_STRATEGY')
    }
    if (opts.tfaActive && !entry.tfaIsActive) {
      throw new Error('ERR_TFA_NOT_ACTIVE')
    }
    return { user, auth, entry }
  }

  /**
   * Update the local-strategy behaviour flags for a user, leaving secrets and any other linked
   * provider untouched.
   *
   * @param flags Any of `mustChangePwd`, `restrictLogin`, `tfaRequired`
   * @returns False if the user does not exist
   */
  async setUserAuthFlags(
    id: string,
    flags: Record<string, any>,
    db: WikiDbOrTx = WIKI.db
  ): Promise<boolean> {
    return this.patchStrategyAuth(
      id,
      WIKI.data.systemIds.localAuthId,
      (entry) => {
        if (!entry) {
          // -> The user does not use local authentication, so there are no local flags to set
          return null
        }
        const patch: Record<string, any> = {}
        for (const key of ['mustChangePwd', 'restrictLogin', 'tfaRequired'] as const) {
          if (flags[key] !== undefined) {
            patch[key] = Boolean(flags[key])
          }
        }
        return patch
      },
      { db }
    )
  }

  /**
   * Set a user's local-strategy password, leaving any other linked provider untouched.
   *
   * @returns False if the user does not exist
   */
  async setUserPassword({
    id,
    newPassword,
    mustChangePassword = false
  }: {
    id: string
    newPassword: string
    mustChangePassword?: boolean
  }): Promise<boolean> {
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    return this.patchStrategyAuth(id, WIKI.data.systemIds.localAuthId, () => ({
      password: passwordHash,
      mustChangePwd: mustChangePassword
    }))
  }

  /**
   * The authentication providers linked to a user, as its own profile page shows them.
   *
   * Reshaped from the stored `auth` blob the same way `getUserDetail()` does it, but reporting only
   * what the user may act on. `isTfaRequired` is what greys out the "turn off 2FA" button, so it
   * accounts for the strategy enforcing 2FA for everyone as well as this user being flagged for it.
   */
  async getProfileAuthMethods(userId: string): Promise<UserProfileAuthMethod[]> {
    const user = await WIKI.models.users.getById(userId)
    if (!user) {
      return []
    }
    return this.describeLinkedProviders(user, { forProfile: true })
  }

  /**
   * Reshape a user's stored `auth` blob into the linked-provider list an API response carries —
   * resolving each strategy id to its row and module definition for the display name and icon, and
   * deriving only state from the entry, never a secret.
   *
   * The two views this serves differ in what they say about each provider, not in how they find it:
   * the administrator's (`getUserDetail`) passes through whatever provider-specific keys the entry
   * carries alongside the derived flags, while the user's own (`getProfileAuthMethods`) reports a
   * fixed set and adds the two things only the account holder acts on — whether password login is on,
   * and whether there is another way in to allow turning it off. `isTfaRequired` differs with it: the
   * profile view greys the "turn off 2FA" button out for a strategy that enforces 2FA on everyone, so
   * it ORs the strategy's own `enforceTfa` in; the admin view reports this user's own flag.
   */
  async describeLinkedProviders(
    user: any,
    opts: { forProfile: true }
  ): Promise<UserProfileAuthMethod[]>
  async describeLinkedProviders(
    user: any,
    opts?: { forProfile?: false }
  ): Promise<UserAuthProvider[]>
  async describeLinkedProviders(
    user: any,
    opts: { forProfile?: boolean } = {}
  ): Promise<UserAuthProvider[]> {
    const strategies = await WIKI.db.select().from(authenticationTable)
    const providers: UserAuthProvider[] = []
    for (const [strategyId, rawConfig] of Object.entries(
      (user.auth ?? {}) as Record<string, any>
    )) {
      const strategy = strategies.find((s: any) => s.id === strategyId)
      const definition = WIKI.data.authentication?.find((d: any) => d.key === strategy?.module)
      const { password, tfaSecret, tfaIsActive, tfaRequired, recoveryCodes, ...rest } =
        rawConfig ?? {}
      const shared = {
        isPasswordSet: Boolean(password),
        // -> Named as the profile page's own view names them, so one piece of state is not called two
        //    things across the API. Whether 2FA is set up is `tfaIsActive` and a stored secret both:
        //    a secret that was generated but never confirmed is not 2FA being on.
        isTfaSetup: Boolean(tfaIsActive && tfaSecret),
        recoveryCodesRemaining: tfaIsActive
          ? ((recoveryCodes ?? []) as RecoveryCodeEntry[]).filter((entry) => !entry.usedAt).length
          : 0
      }
      providers.push({
        authId: strategyId,
        authName: strategy?.displayName || definition?.title || strategy?.module || 'Unknown',
        strategyKey: strategy?.module ?? 'unknown',
        strategyIcon: definition?.icon ?? '',
        config: opts.forProfile
          ? {
              ...shared,
              isTfaRequired: Boolean(
                tfaRequired || (strategy?.config as Record<string, any>)?.enforceTfa
              ),
              isPasswordLoginEnabled: !rawConfig?.restrictLogin,
              canDisablePasswordLogin: countAlternativeLogins(user, strategyId) > 0
            }
          : { ...rest, ...shared, isTfaRequired: Boolean(tfaRequired) }
      })
    }
    return providers
  }

  /**
   * Change a user's own password, having checked the current one.
   *
   * Distinct from `setUserPassword()`, which is an administrator replacing a password it does not
   * know. This also clears `mustChangePwd`: a user who has just chosen a password satisfies the
   * requirement to choose one.
   *
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY`, `ERR_PASSWORD_TOO_SHORT` or
   *         `ERR_INCORRECT_CURRENT_PASSWORD`
   */
  async changeOwnPassword({
    userId,
    strategyId,
    currentPassword,
    newPassword
  }: {
    userId: string
    strategyId: string
    currentPassword: string
    newPassword: string
  }): Promise<void> {
    const user = await WIKI.models.users.getById(userId)
    if (!user) {
      throw new Error('ERR_INVALID_USER')
    }
    if (!newPassword || newPassword.length < 8) {
      throw new Error('ERR_PASSWORD_TOO_SHORT')
    }

    const auth = (user.auth ?? {}) as Record<string, any>
    // -> Only a provider that stores a password here has one to change; an external identity provider
    //    holds it somewhere this instance cannot reach
    if (!auth[strategyId]?.password) {
      throw new Error('ERR_INVALID_STRATEGY')
    }
    if ((await bcrypt.compare(currentPassword, auth[strategyId].password)) !== true) {
      WIKI.models.flags.authDebug(
        `Password change for user ${userId} rejected: the current password did not match`
      )
      throw new Error('ERR_INCORRECT_CURRENT_PASSWORD')
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    await this.patchStrategyAuth(userId, strategyId, () => ({
      password: passwordHash,
      mustChangePwd: false
    }))
  }

  /**
   * Turn password login on or off for a user's own account, which is the same `restrictLogin` flag an
   * administrator sets from the admin area.
   *
   * Turning it off is refused unless something else can still sign the account in — a passkey or
   * another linked provider — because the alternative is a user locking themselves out of their own
   * account with one click. Turning it back on needs no such check, and the password itself is neither
   * cleared nor asked for: a session that got this far has already been authenticated.
   *
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY`, `ERR_PASSWORD_LOGIN_NOT_APPLICABLE` or
   *         `ERR_NO_OTHER_LOGIN_METHOD`
   */
  async setPasswordLoginEnabled({
    userId,
    strategyId,
    isEnabled
  }: {
    userId: string
    strategyId: string
    isEnabled: boolean
  }): Promise<void> {
    const { user, entry } = await this.requireStrategyAuth(userId, strategyId)

    // -> The flag is only ever read by the local module's `authenticate()`, so setting it on a provider
    //    that authenticates elsewhere would be a switch connected to nothing
    const strategy = await WIKI.models.authentication.getStrategyById(strategyId)
    if (strategy?.module !== 'local' || !entry.password) {
      throw new Error('ERR_PASSWORD_LOGIN_NOT_APPLICABLE')
    }

    if (!isEnabled && countAlternativeLogins(user, strategyId) < 1) {
      throw new Error('ERR_NO_OTHER_LOGIN_METHOD')
    }

    await this.patchStrategyAuth(userId, strategyId, () => ({ restrictLogin: !isEnabled }))

    WIKI.models.flags.authDebug(
      `User ${userId} <${user.email}> turned password login ${isEnabled ? 'on' : 'off'}`
    )
  }

  /**
   * Start 2FA setup for a user: store a fresh secret, inactive, and return the QR code to scan.
   *
   * The secret is stored before it is proven to work, because the user has to be able to scan it and
   * come back with a code generated from it. It counts for nothing until `enableTfa()` marks it
   * active, and starting the setup again simply replaces it.
   *
   * @param user The user row, whose `auth` blob is updated in place as well as saved
   * @param siteId The site being logged into, which names the entry in the authenticator app
   * @returns The QR code as an SVG document, and the secret it encodes — which is shown as text too,
   *          for a user who would rather type it into an authenticator app than scan anything
   */
  async startTfaSetup(
    user: any,
    strategyId: string,
    siteId?: string
  ): Promise<{ secret: string; tfaQRImage: string }> {
    WIKI.logger.debug(`Generating a new 2FA secret for user ${user.id}...`)

    // -> The title is only a label in the user's authenticator app, so any site will do when the one
    //    being logged into cannot be resolved
    const site = (siteId ? WIKI.sites[siteId] : null) ?? Object.values(WIKI.sites ?? {})[0]
    const issuer = (site as any)?.config?.title || 'Wiki'

    const secret = generateTotpSecret()
    await this.patchStrategyAuth(
      user.id,
      strategyId,
      () => ({ tfaSecret: secret, tfaIsActive: false }),
      { mirrorInto: user }
    )

    return {
      secret,
      tfaQRImage: await QRCode.toString(buildTotpUri({ secret, account: user.email, issuer }), {
        type: 'svg',
        margin: 1
      })
    }
  }

  /**
   * Mark a user's stored 2FA secret as active, i.e. required from now on, and issue a fresh set of
   * recovery codes alongside it. Called once the user has proven the secret produces the codes this
   * server expects — from a login that owed a required setup (`loginTFA`) or from the profile page
   * (`confirmTfaSetup`), which is why the codes are generated here rather than in either caller: both
   * routes to becoming active go through this one place.
   *
   * @returns The recovery codes in plaintext. Only their hashes are stored, so this is the one and
   *          only time the caller can get at them — display or offer them for download immediately.
   */
  async enableTfa(user: any, strategyId: string): Promise<string[]> {
    const { plaintext, entries } = await issueRecoveryCodes()
    await this.patchStrategyAuth(
      user.id,
      strategyId,
      () => ({ tfaIsActive: true, recoveryCodes: entries }),
      { mirrorInto: user }
    )
    WIKI.models.flags.authDebug(`User ${user.id} <${user.email}> enabled 2FA`)
    return plaintext
  }

  /**
   * Turn 2FA off for a user and forget the secret, so that setting it up again starts from a new one.
   *
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY`, `ERR_TFA_NOT_ACTIVE` or `ERR_TFA_ENFORCED`
   */
  async disableTfa(userId: string, strategyId: string): Promise<void> {
    const { user, entry } = await this.requireStrategyAuth(userId, strategyId, { tfaActive: true })

    // -> Turning it off would be undone at the next login, which is worth an error rather than a
    //    confusing round trip. The client greys the button out, but that is a client.
    const strategy = await WIKI.models.authentication.getStrategyById(strategyId)
    if (entry.tfaRequired || (strategy?.config as Record<string, any>)?.enforceTfa) {
      throw new Error('ERR_TFA_ENFORCED')
    }

    await this.patchStrategyAuth(userId, strategyId, clearedTfa)
    WIKI.models.flags.authDebug(`User ${userId} <${user.email}> disabled 2FA`)
  }

  /**
   * Turn 2FA off for a user on an administrator's say-so, bypassing the `tfaRequired` /
   * `enforceTfa` enforcement that `disableTfa()` deliberately refuses to override.
   *
   * A genuinely separate method rather than a parameter on `disableTfa()`: that method's whole point
   * is to refuse this exact override for a user acting on their own account, so folding the bypass in
   * as a flag would make the refusal something every caller has to remember to ask for, instead of
   * something only an admin-scoped route can reach at all. Overriding enforcement is the entire
   * reason this control exists — typically to recover a user locked out by a lost authenticator or
   * device, where waiting for them to satisfy the requirement they are asking to be freed from isn't
   * an option.
   *
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY` or `ERR_TFA_NOT_ACTIVE`
   */
  async adminInvalidateTfa(userId: string, strategyId: string): Promise<void> {
    const { user } = await this.requireStrategyAuth(userId, strategyId, { tfaActive: true })

    await this.patchStrategyAuth(userId, strategyId, clearedTfa)
    WIKI.models.flags.authDebug(
      `User ${userId} <${user.email}> had 2FA invalidated by an administrator`
    )
  }

  /**
   * Whether a security code matches the 2FA secret stored for a user under one strategy -- and, if
   * so, whether it has not already been accepted once before.
   *
   * `verifyTotpCode` returns which time-step counter the code matched (or -1); this persists the
   * highest counter ever accepted, as `auth[strategyId].tfaLastCounter`, and refuses any code whose
   * matched counter is not strictly greater than it. Without this, the ~90s window RFC 6238's
   * allowed drift keeps a code valid for (three 30s steps) would let an observed code -- shoulder-
   * surfed, phished, screenshotted -- be replayed for as long as it stays inside that window.
   *
   * The read-check-write runs under {@link authLockKey}'s per-user lock, re-reading the row instead
   * of trusting the possibly-stale `user` the caller loaded earlier: two concurrent submissions of
   * the same still-valid code must not both see themselves as the first to present it.
   */
  async verifyTfaCode(user: any, strategyId: string, securityCode: string): Promise<boolean> {
    const secret = ((user.auth ?? {}) as Record<string, any>)[strategyId]?.tfaSecret
    if (!secret) {
      return false
    }
    const matchedCounter = verifyTotpCode(secret, securityCode)
    if (matchedCounter < 0) {
      return false
    }

    return this.patchStrategyAuth(
      user.id,
      strategyId,
      (entry) => {
        const lastCounter = entry?.tfaLastCounter ?? -1
        if (matchedCounter <= lastCounter) {
          // -> A code for this counter (or an earlier one) has already been accepted -- reject the
          //    replay rather than sign in a second time on the strength of the same code.
          return null
        }
        return { tfaLastCounter: matchedCounter }
      },
      { mirrorInto: user }
    )
  }

  /**
   * Whether a recovery code matches one of the unconsumed codes stored for a user's 2FA. On a match,
   * marks that entry consumed so it cannot be redeemed a second time.
   *
   * The match-then-mark runs under {@link authLockKey}'s per-user lock, and re-reads the row rather
   * than trusting the possibly-stale `user` the caller loaded earlier -- so two concurrent
   * submissions of the same code cannot both observe it as unconsumed and both redeem it. The loser
   * of the race sees the entry already marked `usedAt` by the winner and correctly reports no match.
   *
   * @param user The user row -- only `.id` is trusted; `.auth` is re-read fresh inside the lock, and
   *             the caller's copy is updated in place to match once the write lands
   * @returns Whether the code matched an unconsumed entry
   */
  async verifyAndConsumeRecoveryCode(
    user: any,
    strategyId: string,
    code: string
  ): Promise<boolean> {
    const normalizedCode = normalizeRecoveryCode(code)
    const consumed = await this.patchStrategyAuth(
      user.id,
      strategyId,
      async (stored) => {
        const entries = (stored?.recoveryCodes ?? []) as RecoveryCodeEntry[]
        const matchedIndex = await matchRecoveryCode(entries, normalizedCode)
        if (matchedIndex < 0) {
          return null
        }
        return {
          recoveryCodes: entries.map((entry, i) =>
            i === matchedIndex
              ? {
                  ...entry,
                  usedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' })
                }
              : entry
          )
        }
      },
      { mirrorInto: user }
    )
    if (consumed) {
      WIKI.models.flags.authDebug(`User ${user.id} <${user.email}> consumed a 2FA recovery code`)
    }
    return consumed
  }

  /**
   * How many of a user's 2FA recovery codes are still unused, without ever re-displaying one.
   *
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY` or `ERR_TFA_NOT_ACTIVE`
   */
  async getRecoveryCodesStatus(
    userId: string,
    strategyId: string
  ): Promise<{ total: number; remaining: number }> {
    // -> No 2FA, no codes: rather than answering `{ total: 0, remaining: 0 }` for an account that
    //    was never set up for recovery codes in the first place, this is treated the same as any
    //    other 2FA-inactive request.
    const { entry } = await this.requireStrategyAuth(userId, strategyId, { tfaActive: true })
    const entries = (entry.recoveryCodes ?? []) as RecoveryCodeEntry[]
    return {
      total: entries.length,
      remaining: entries.filter((entry) => !entry.usedAt).length
    }
  }

  /**
   * Invalidate every recovery code currently stored for a user's 2FA and issue a fresh set in its
   * place — a partially-consumed set is not topped back up to a full one, the whole thing is thrown
   * away and replaced, used and unused codes alike.
   *
   * @returns The new codes in plaintext, and whether the set being replaced still had unused codes in
   *          it — the caller's cue to warn the user that codes they saved are being thrown away, not
   *          just supplemented
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY` or `ERR_TFA_NOT_ACTIVE`
   */
  async regenerateRecoveryCodes(
    userId: string,
    strategyId: string
  ): Promise<{ recoveryCodes: string[]; hadUnusedCodes: boolean }> {
    const { user, entry: stored } = await this.requireStrategyAuth(userId, strategyId, {
      tfaActive: true
    })

    const previousEntries = (stored.recoveryCodes ?? []) as RecoveryCodeEntry[]
    const hadUnusedCodes = previousEntries.some((entry) => !entry.usedAt)

    const { plaintext, entries } = await issueRecoveryCodes()
    await this.patchStrategyAuth(userId, strategyId, () => ({ recoveryCodes: entries }))
    WIKI.models.flags.authDebug(
      `User ${userId} <${user.email}> regenerated their 2FA recovery codes`
    )
    return { recoveryCodes: plaintext, hadUnusedCodes }
  }

  /**
   * Purge every outstanding `userKeys` row for a user -- reset-password, email-verify, TFA-setup and
   * change-password tokens alike.
   *
   * The counterpart to `sessions.clearSessionsFromUser()` for deactivation (`api/users.ts`'s
   * `patch.isActive === false` path calls both): a token minted before an account was deactivated
   * would otherwise still be redeemable afterwards. `afterLoginChecks()` would refuse the login that
   * redemption ends in, but not before `resetPassword()` has already rewritten the password hash --
   * purging the row here means the token never gets that far.
   */
  async clearKeysFromUser(userId: string, db: WikiDbOrTx = WIKI.db): Promise<void> {
    await db.delete(userKeys).where(eq(userKeys.userId, userId))
  }

  async generateToken({
    userId,
    kind,
    meta = {}
  }: {
    userId: string
    kind: string
    meta?: Record<string, any>
  }): Promise<string> {
    WIKI.logger.debug(`Generating ${kind} token for user ${userId}...`)
    const token = await nanoid()
    await WIKI.db.insert(userKeys).values({
      kind,
      token,
      meta,
      // NOTE: ISO string rather than a Date, for the same UTC-vs-local reason as models/jobs.ts.
      //       24 hours rather than 1 day: Temporal.Instant takes exact time units only, and in UTC
      //       a calendar day is exactly 24 hours.
      validUntil: Temporal.Now.instant()
        .add({ hours: 24 })
        .toString({ smallestUnit: 'millisecond' }) as any,
      userId
    })
    return token
  }

  async validateToken({
    kind,
    token,
    skipDelete
  }: {
    kind: string
    token: string
    skipDelete?: boolean
  }): Promise<any> {
    const res = await WIKI.db.query.userKeys.findFirst({
      where: {
        kind,
        token
      },
      with: {
        user: true
      }
    })
    if (res) {
      if (skipDelete !== true) {
        await WIKI.db.delete(userKeys).where(eq(userKeys.id, res.id))
      }
      // -> BEHAVIOR CHANGE (Temporal migration): this previously read
      //    `DateTime.utc() > DateTime.fromISO(res.validUntil)`. `validUntil` is a `timestamp`
      //    column, so drizzle hands back a Date, and `fromISO` given a Date produced an *Invalid*
      //    DateTime whose comparison was always false — tokens never expired. Temporal has no
      //    Invalid sentinel to reproduce that with, so the check now works as intended.
      if (
        Temporal.Instant.compare(Temporal.Now.instant(), res.validUntil.toTemporalInstant()) > 0
      ) {
        throw new Error('ERR_EXPIRED_VALIDATION_TOKEN')
      }
      return {
        ...(res.meta as Record<string, any>),
        user: res.user
      }
    } else {
      throw new Error('ERR_INVALID_VALIDATION_TOKEN')
    }
  }

  async destroyToken({ token }: { token: string }) {
    return WIKI.db.delete(userKeys).where(eq(userKeys.token, token))
  }

  /**
   * Sweep `userKeys` rows past their `validUntil` -- a row otherwise only goes when consumed
   * (`validateToken()` above, `register()`'s email-verification path), destroyed (`destroyToken()`
   * above) or when its user is deleted, so a token generated and never presented (an abandoned
   * password-reset link, an abandoned 2FA continuation) would otherwise accumulate forever. Mirrors
   * `pageviews.ts#purgeExpired()`'s shape.
   */
  async purgeExpiredKeys(): Promise<number> {
    const result = await WIKI.db.delete(userKeys).where(lt(userKeys.validUntil, sql`now()`))
    return result.rowCount ?? 0
  }
}

export const userCredentials = new UserCredentials()
