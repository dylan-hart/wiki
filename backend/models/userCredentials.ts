import bcrypt from 'bcryptjs'
import QRCode from 'qrcode'
import {
  authentication as authenticationTable,
  users as usersTable,
  userKeys
} from '../db/schema.ts'
import { eq, lt, sql } from 'drizzle-orm'
import type { WikiDbOrTx } from '../core/db.ts'
import { BCRYPT_ROUNDS } from '../helpers/common.ts'
import { passkeysAllowed } from './security.ts'
import { randomToken } from '../helpers/randomToken.ts'
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from '../helpers/totp.ts'
import { withAdvisoryLock } from '../helpers/advisoryLock.ts'
import { generateRecoveryCodes, normalizeRecoveryCode } from '../helpers/recoveryCodes.ts'

/**
 * `config` is a pass-through of the stored `auth` entry minus every secret it holds (the password
 * hash, the TFA secret, the recovery-code hashes) — those are reported as derived state instead.
 */
export interface UserAuthProvider {
  authId: string
  authName: string
  strategyKey: string
  strategyIcon: string
  config: Record<string, any>
}

export interface UserProfileAuthMethod {
  authId: string
  authName: string
  strategyKey: string
  strategyIcon: string
  config: {
    isPasswordSet: boolean
    isTfaSetup: boolean
    isTfaRequired: boolean
    isPasswordLoginEnabled: boolean
    canChangePassword: boolean
    canDisablePasswordLogin: boolean
    /** 0 when 2FA is off, not the leftovers of a previous setup. */
    recoveryCodesRemaining: number
  }
}

/** Stored on `auth[strategyId].recoveryCodes`; the plaintext is never kept anywhere. */
export interface RecoveryCodeEntry {
  hash: string
  usedAt: string | null
}

/**
 * Every write to `users.auth` reads the entire JSONB column, mutates part of it in memory and writes
 * the whole column back, with no row lock and no conditional `WHERE` -- so two such writes for the
 * same user racing is a lost update. Every read-modify-write below holds this per-user lock across
 * both halves; writers for different users never block each other.
 */
function authLockKey(userId: string): string {
  return `wiki:user-auth:${userId}`
}

/**
 * The secret is forgotten rather than kept inactive, so setting 2FA up again starts from a genuinely
 * new one rather than silently re-arming the old.
 *
 * A factory rather than a shared constant: the value is merged into a stored JSON blob, and handing
 * two accounts the same `recoveryCodes` array would make them one array.
 */
function clearedTfa(): Record<string, any> {
  return { tfaIsActive: false, tfaSecret: '', recoveryCodes: [] }
}

/**
 * A token that has already been destroyed, or never existed, is not an error here: the caller is
 * about to reject the attempt either way.
 */
export async function countTfaFailure(token: string): Promise<void> {
  const rows = await CARDINAL.db
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
    await CARDINAL.db.delete(userKeys).where(eq(userKeys.id, row.id))
    CARDINAL.models.flags.authDebug(
      `Discarded the 2FA continuation token of user ${row.userId} after ${attempts} incorrect codes`
    )
    return
  }
  await CARDINAL.db
    .update(userKeys)
    .set({ meta: { ...meta, attempts } })
    .where(eq(userKeys.id, row.id))
}

/**
 * Retries have to be allowed — six digits get mistyped, and a code that rotates every 30 seconds is
 * regularly entered a moment too late — but unlimited retries against a token that lives for 24
 * hours is a code space small enough to walk through.
 */
const maxTfaAttempts = 5

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
 * Failures are swallowed: an unconfigured or unreachable mail transport must not turn a 2FA action
 * that already succeeded into a failed one.
 */
async function notifyRecoveryCodesGenerated(user: any, siteId?: string): Promise<void> {
  try {
    await CARDINAL.models.mail.sendTfaRecoveryCodesGenerated({
      to: user.email,
      name: user.name,
      userId: user.id,
      locale: user.prefs?.locale,
      siteId
    })
  } catch (err: any) {
    CARDINAL.logger.warn('auth', 'sending the tfa-recovery-codes-generated notice failed', {
      user: user.id,
      error: err
    })
  }
}

/**
 * Every unconsumed entry is compared, not just up to the first hit, so how long this takes does not
 * depend on which one (if any) matched. An already-consumed entry is skipped without comparison: it
 * can never match again whatever was typed, so there is nothing to hide by skipping it.
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
 * How many ways into the account remain if the given provider stops working. A provider that is
 * itself restricted does not count — it is no way in either. Passkeys count whichever host they were
 * registered against: on a multi-site instance one bound to another site still leaves the account
 * reachable.
 */
export function countAlternativeLogins(user: any, strategyId: string): number {
  const auth = (user.auth ?? {}) as Record<string, any>
  const otherProviders = Object.entries(auth).filter(
    ([id, config]) => id !== strategyId && !config?.restrictLogin
  ).length
  const passkeys = passkeysAllowed() ? ((user.passkeys ?? {}).authenticators ?? []).length : 0
  return otherProviders + passkeys
}

/**
 * `users` owns who exists; this owns how they prove it — the `auth` blob (passwords, the 2FA
 * lifecycle, recovery codes) and the short-lived `userKeys` tokens.
 */
class UserCredentials {
  /**
   * The read-modify-write every `users.auth` change is made of, holding {@link authLockKey}'s
   * per-user lock and re-reading the row INSIDE it — never trusting a `user` the caller loaded
   * earlier, which is the whole point of the lock.
   *
   * @param mutate Given this strategy's CURRENT entry (undefined when the user has none), returns the
   *   fields to merge into it — or `null` to make the whole call a no-op, which is how a redemption
   *   that finds nothing to redeem, or a replayed TOTP code, declines to write anything at all
   * @param opts.db Joins a caller's open transaction rather than racing it
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
    const db = opts.db ?? CARDINAL.db
    return withAdvisoryLock(authLockKey(userId), async () => {
      const current = await CARDINAL.models.users.getById(userId, db)
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
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY` or `ERR_TFA_NOT_ACTIVE`
   */
  async requireStrategyAuth(
    userId: string,
    strategyId: string,
    opts: { tfaActive?: boolean } = {}
  ): Promise<{ user: any; auth: Record<string, any>; entry: Record<string, any> }> {
    const user = await CARDINAL.models.users.getById(userId)
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

  async setUserAuthFlags(
    id: string,
    flags: Record<string, any>,
    db: WikiDbOrTx = CARDINAL.db
  ): Promise<boolean> {
    return this.patchStrategyAuth(
      id,
      CARDINAL.data.systemIds.localAuthId,
      (entry) => {
        if (!entry) {
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
    return this.patchStrategyAuth(id, CARDINAL.data.systemIds.localAuthId, () => ({
      password: passwordHash,
      mustChangePwd: mustChangePassword
    }))
  }

  async getProfileAuthMethods(userId: string): Promise<UserProfileAuthMethod[]> {
    const user = await CARDINAL.models.users.getById(userId)
    if (!user) {
      return []
    }
    return this.describeLinkedProviders(user, { forProfile: true })
  }

  /**
   * The destructure is what keeps every secret out of the response: the admin view spreads whatever
   * provider-specific keys are left in `rest`, so a new secret added to a stored entry has to be
   * pulled out here too or it ships to the client.
   *
   * The profile view ORs the strategy's own `enforceTfa` into `isTfaRequired` because that is what
   * greys its "turn off 2FA" button out; the admin view reports this user's own flag alone.
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
    const strategies = await CARDINAL.db.select().from(authenticationTable)
    const providers: UserAuthProvider[] = []
    for (const [strategyId, rawConfig] of Object.entries(
      (user.auth ?? {}) as Record<string, any>
    )) {
      const strategy = strategies.find((s: any) => s.id === strategyId)
      const definition = CARDINAL.data.authentication?.find((d: any) => d.key === strategy?.module)
      const { password, tfaSecret, tfaIsActive, tfaRequired, recoveryCodes, ...rest } =
        rawConfig ?? {}
      const shared = {
        isPasswordSet: Boolean(password),
        // -> Both halves: a secret that was generated but never confirmed is not 2FA being on.
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
              canChangePassword:
                (strategy?.config as Record<string, any>)?.allowPasswordChange !== false,
              canDisablePasswordLogin: countAlternativeLogins(user, strategyId) > 0
            }
          : { ...rest, ...shared, isTfaRequired: Boolean(tfaRequired) }
      })
    }
    return providers
  }

  /**
   * Distinct from `setUserPassword()`, which is an administrator replacing a password it does not
   * know. Clearing `mustChangePwd` is deliberate: a user who has just chosen a password satisfies
   * the requirement to choose one.
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
    const user = await CARDINAL.models.users.getById(userId)
    if (!user) {
      throw new Error('ERR_INVALID_USER')
    }
    if (!newPassword || newPassword.length < 8) {
      throw new Error('ERR_PASSWORD_TOO_SHORT')
    }

    const auth = (user.auth ?? {}) as Record<string, any>
    // -> An external identity provider holds the password somewhere this instance cannot reach
    if (!auth[strategyId]?.password) {
      throw new Error('ERR_INVALID_STRATEGY')
    }
    const strategy = await CARDINAL.models.authentication.getStrategyById(strategyId)
    if (strategy?.config?.allowPasswordChange === false) {
      throw new Error('ERR_PASSWORD_CHANGE_DISABLED')
    }
    if ((await bcrypt.compare(currentPassword, auth[strategyId].password)) !== true) {
      CARDINAL.models.flags.authDebug(
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
   * The same `restrictLogin` flag an administrator sets from the admin area. Turning it off is
   * refused unless something else can still sign the account in, because the alternative is a user
   * locking themselves out with one click. Turning it back on needs no such check, and the password
   * is neither cleared nor asked for: a session that got this far is already authenticated.
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

    // -> Only the local module's `authenticate()` reads the flag, so setting it on a provider that
    //    authenticates elsewhere would be a switch connected to nothing
    const strategy = await CARDINAL.models.authentication.getStrategyById(strategyId)
    if (strategy?.module !== 'local' || !entry.password) {
      throw new Error('ERR_PASSWORD_LOGIN_NOT_APPLICABLE')
    }

    if (!isEnabled && countAlternativeLogins(user, strategyId) < 1) {
      throw new Error('ERR_NO_OTHER_LOGIN_METHOD')
    }

    await this.patchStrategyAuth(userId, strategyId, () => ({ restrictLogin: !isEnabled }))

    CARDINAL.models.flags.authDebug(
      `User ${userId} <${user.email}> turned password login ${isEnabled ? 'on' : 'off'}`
    )
  }

  /**
   * The secret is stored before it is proven to work, because the user has to scan it and come back
   * with a code generated from it. It counts for nothing until `enableTfa()` marks it active, and
   * starting the setup again simply replaces it.
   *
   * @param user Updated in place as well as saved
   */
  async startTfaSetup(
    user: any,
    strategyId: string,
    siteId?: string
  ): Promise<{ secret: string; tfaQRImage: string }> {
    CARDINAL.logger.debug('auth', 'generating a new 2FA secret', { user: user.id })

    // -> The issuer is only a label in the user's authenticator app, so any site will do when the one
    //    being logged into cannot be resolved
    const site = (siteId ? CARDINAL.sites[siteId] : null) ?? Object.values(CARDINAL.sites ?? {})[0]
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
   * Called once the user has proven the secret produces the codes this server expects, from either
   * `loginTFA` or `confirmTfaSetup`. The recovery codes are issued here rather than in either caller
   * because both routes to becoming active go through this one place.
   *
   * @param siteId The site the enabling login/setup came in on, when known — `confirmTfaSetup`'s own
   *   profile route has none, and the notices then link to the instance-wide `defaultBaseURL`
   * @returns The recovery codes in plaintext. Only their hashes are stored, so this is the one and
   *          only time the caller can get at them — display or offer them for download immediately.
   */
  async enableTfa(user: any, strategyId: string, siteId?: string, ip?: string): Promise<string[]> {
    const { plaintext, entries } = await issueRecoveryCodes()
    await this.patchStrategyAuth(
      user.id,
      strategyId,
      () => ({ tfaIsActive: true, recoveryCodes: entries }),
      { mirrorInto: user }
    )
    CARDINAL.models.flags.authDebug(`User ${user.id} <${user.email}> enabled 2FA`)
    await CARDINAL.models.auditLog.record({
      event: 'user.tfaEnabled',
      actor: { id: user.id, name: user.name, email: user.email, ip },
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      detail: { strategyId },
      siteId: siteId ?? null
    })

    await notifyRecoveryCodesGenerated(user, siteId)

    // -> A mail-send failure must not turn a successful 2FA enable into a failed one
    try {
      await CARDINAL.models.mail.sendTfaEnabled({
        to: user.email,
        name: user.name,
        userId: user.id,
        locale: user.prefs?.locale,
        siteId
      })
    } catch (err: any) {
      CARDINAL.logger.warn('auth', 'sending the 2FA-enabled notice failed', {
        user: user.id,
        error: err
      })
    }

    return plaintext
  }

  /**
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY`, `ERR_TFA_NOT_ACTIVE` or `ERR_TFA_ENFORCED`
   */
  async disableTfa(userId: string, strategyId: string, ip?: string): Promise<void> {
    const { user, entry } = await this.requireStrategyAuth(userId, strategyId, { tfaActive: true })

    // -> Turning it off would be undone at the next login, which is worth an error rather than a
    //    confusing round trip. The client greys the button out, but that is a client.
    const strategy = await CARDINAL.models.authentication.getStrategyById(strategyId)
    if (entry.tfaRequired || (strategy?.config as Record<string, any>)?.enforceTfa) {
      throw new Error('ERR_TFA_ENFORCED')
    }

    await this.patchStrategyAuth(userId, strategyId, clearedTfa)
    CARDINAL.models.flags.authDebug(`User ${userId} <${user.email}> disabled 2FA`)
    await CARDINAL.models.auditLog.record({
      event: 'user.tfaDisabled',
      actor: { id: userId, name: user.name, email: user.email, ip },
      targetType: 'user',
      targetId: userId,
      targetLabel: user.email,
      detail: { strategyId }
    })
    await this.notifyTfaDisabled(user)
  }

  /**
   * Bypasses the `tfaRequired`/`enforceTfa` enforcement `disableTfa()` refuses to override — which
   * is why it is a separate method rather than a flag on that one: folding the bypass in would make
   * the refusal something every caller has to remember to ask for, instead of something only an
   * admin-scoped route can reach at all. It exists to recover a user locked out by a lost
   * authenticator, who cannot satisfy the requirement they are asking to be freed from.
   *
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY` or `ERR_TFA_NOT_ACTIVE`
   */
  async adminInvalidateTfa(userId: string, strategyId: string): Promise<void> {
    const { user } = await this.requireStrategyAuth(userId, strategyId, { tfaActive: true })

    await this.patchStrategyAuth(userId, strategyId, clearedTfa)
    CARDINAL.models.flags.authDebug(
      `User ${userId} <${user.email}> had 2FA invalidated by an administrator`
    )
    await this.notifyTfaDisabled(user)
  }

  /**
   * `user` is the account holder, never the acting admin — load-bearing for `adminInvalidateTfa()`,
   * where the locale the notice is written in would otherwise be the wrong person's. A mail-send
   * failure must not turn a successful 2FA disable into a failed one.
   */
  private async notifyTfaDisabled(user: any): Promise<void> {
    try {
      await CARDINAL.models.mail.sendTfaDisabled({
        to: user.email,
        name: user.name,
        userId: user.id,
        locale: user.prefs?.locale
      })
    } catch (err: any) {
      CARDINAL.logger.warn('auth', 'sending the 2FA-disabled notice failed', {
        user: user.id,
        error: err
      })
    }
  }

  /**
   * Persists the highest time-step counter ever accepted as `auth[strategyId].tfaLastCounter` and
   * refuses any code whose matched counter is not strictly greater. Without it, the ~90s of drift
   * RFC 6238 allows would let an observed code -- shoulder-surfed, phished, screenshotted -- be
   * replayed for as long as it stays inside that window.
   *
   * The read-check-write runs under {@link authLockKey}'s per-user lock, so two concurrent
   * submissions of the same still-valid code cannot both see themselves as the first to present it.
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
          // -> Already accepted once: reject the replay rather than sign in a second time on the
          //    strength of the same code.
          return null
        }
        return { tfaLastCounter: matchedCounter }
      },
      { mirrorInto: user }
    )
  }

  /**
   * The match-then-mark runs under {@link authLockKey}'s per-user lock, so two concurrent
   * submissions of the same code cannot both observe it as unconsumed and both redeem it. The loser
   * of the race sees the entry already marked `usedAt` by the winner and correctly reports no match.
   *
   * @param user Only `.id` is trusted; `.auth` is re-read inside the lock and the caller's copy
   *             updated in place once the write lands
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
      CARDINAL.models.flags.authDebug(
        `User ${user.id} <${user.email}> consumed a 2FA recovery code`
      )
    }
    return consumed
  }

  /**
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY` or `ERR_TFA_NOT_ACTIVE`
   */
  async getRecoveryCodesStatus(
    userId: string,
    strategyId: string
  ): Promise<{ total: number; remaining: number }> {
    // -> An account with 2FA off throws rather than answering `{ total: 0, remaining: 0 }`, which
    //    would be indistinguishable from a set of codes that has been entirely used up.
    const { entry } = await this.requireStrategyAuth(userId, strategyId, { tfaActive: true })
    const entries = (entry.recoveryCodes ?? []) as RecoveryCodeEntry[]
    return {
      total: entries.length,
      remaining: entries.filter((entry) => !entry.usedAt).length
    }
  }

  /**
   * A partially-consumed set is not topped back up: the whole thing is replaced, used and unused
   * codes alike.
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
    CARDINAL.models.flags.authDebug(
      `User ${userId} <${user.email}> regenerated their 2FA recovery codes`
    )

    await notifyRecoveryCodesGenerated(user)

    return { recoveryCodes: plaintext, hadUnusedCodes }
  }

  async linkStrategy({
    userId,
    strategyId,
    identity,
    methodName,
    siteId,
    ip
  }: {
    userId: string
    strategyId: string
    identity: { id: string; email: string }
    methodName: string
    siteId?: string
    ip?: string
  }): Promise<void> {
    const written = await this.patchStrategyAuth(userId, strategyId, async (entry) => {
      if (entry) {
        throw new Error('ERR_LINK_ALREADY_LINKED')
      }
      const holder = await CARDINAL.models.users.getByProviderLink(strategyId, identity.id)
      if (holder) {
        throw new Error(
          holder.id === userId ? 'ERR_LINK_ALREADY_LINKED' : 'ERR_LINK_IDENTITY_IN_USE'
        )
      }
      return { id: identity.id, email: identity.email }
    })
    if (!written) {
      throw new Error('ERR_LINK_NOT_SIGNED_IN')
    }

    const user = await CARDINAL.models.users.getById(userId)
    if (!user) {
      return
    }
    CARDINAL.models.flags.authDebug(`User ${userId} connected sign-in strategy ${strategyId}`)
    await CARDINAL.models.auditLog.record({
      event: 'user.signInMethodAdded',
      actor: { id: userId, name: user.name, email: user.email, ip },
      targetType: 'user',
      targetId: userId,
      targetLabel: user.email,
      detail: { strategyId },
      siteId: siteId || null
    })
    try {
      await CARDINAL.models.mail.sendSignInMethodAdded({
        to: user.email,
        name: user.name,
        methodName,
        userId,
        locale: (user.prefs as Record<string, any> | null)?.locale,
        siteId: siteId || undefined
      })
    } catch (err: any) {
      CARDINAL.logger.warn('auth', 'sending the sign-in-method-added notice failed', {
        user: userId,
        error: err
      })
    }
  }

  /**
   * The counterpart to `sessions.clearSessionsFromUser()` when an account is deactivated: a token
   * minted beforehand would otherwise still be redeemable. `afterLoginChecks()` would refuse the
   * login that redemption ends in, but not before `resetPassword()` has already rewritten the
   * password hash -- purging the row means the token never gets that far.
   */
  async clearKeysFromUser(userId: string, db: WikiDbOrTx = CARDINAL.db): Promise<void> {
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
    CARDINAL.logger.debug('auth', 'generating a token', { kind, user: userId })
    const token = randomToken()
    await CARDINAL.db.insert(userKeys).values({
      kind,
      token,
      meta,
      // -> An ISO string rather than a Date, so the value stays UTC. `{ hours: 24 }` rather than
      //    `{ days: 1 }`: `Temporal.Instant` takes exact time units only, and throws on the latter.
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
    const res = await CARDINAL.db.query.userKeys.findFirst({
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
        await CARDINAL.db.delete(userKeys).where(eq(userKeys.id, res.id))
      }
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
    return CARDINAL.db.delete(userKeys).where(eq(userKeys.token, token))
  }

  /**
   * A row otherwise only goes when consumed, destroyed or when its user is deleted, so a token
   * generated and never presented -- an abandoned password-reset link, an abandoned 2FA
   * continuation -- would accumulate forever.
   */
  async purgeExpiredKeys(): Promise<number> {
    const result = await CARDINAL.db.delete(userKeys).where(lt(userKeys.validUntil, sql`now()`))
    return result.rowCount ?? 0
  }
}

export const userCredentials = new UserCredentials()
