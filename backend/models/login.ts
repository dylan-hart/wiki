import bcrypt from 'bcryptjs'
import { and, eq, sql } from 'drizzle-orm'
import { tfaKnownDevices, users as usersTable } from '../db/schema.ts'
import { BCRYPT_ROUNDS, generateHash, isUniqueViolation } from '../helpers/common.ts'
import { randomToken } from '../helpers/randomToken.ts'
import { syncRevocableGroupIds } from '../helpers/groupSync.ts'
import { coalesce } from '../helpers/logCoalesce.ts'
import {
  AccountRateLimitedError,
  authRateLimitWindowMs,
  consumeAccountAuthAttempt
} from '../helpers/rateLimit.ts'
import { isRecoveryCodeShape } from '../helpers/recoveryCodes.ts'
import { testRegexSafely } from '../helpers/safeRegexTest.ts'
import { ProvisionableLoginError } from './authentication.ts'
import { deriveDisplayName } from './users.ts'
import { countTfaFailure } from './userCredentials.ts'
import type { AuthStrategy, ProviderProfile } from './authentication.ts'
import type { RecoveryCodeEntry } from './userCredentials.ts'

export interface LoginOptions {
  siteId: string
  strategyId: string
  username?: string
  password?: string
  ip?: string
}

export interface AfterLoginResult {
  authenticated?: boolean
  nextAction: string
  continuationToken?: string
  tfaQRImage?: string
  /**
   * Present only when this login just activated 2FA: the fresh codes in plaintext, for the user to
   * save. Only hashes are kept, so they are never reconstructable afterwards.
   */
  recoveryCodes?: string[]
  redirect: string
}

/**
 * `redirect` is optional rather than this being a union: a pending verification answers a bare
 * `{ nextAction: 'verify' }`, which has none.
 */
export interface RegisterResult {
  authenticated?: boolean
  nextAction: string
  continuationToken?: string
  tfaQRImage?: string
  redirect?: string
}

/**
 * Closed rather than free text because this is what an operator greps and counts: `reason=` has to
 * mean the same thing in every line that carries it. One member per refusal branch, nothing
 * speculative. No reason distinguishes "no such account" from "wrong password" — both are
 * `bad-credentials`, because inventing the distinction here would publish an account-enumeration
 * oracle into the log. A strategy that is turned off is simply absent from
 * `CARDINAL.auth.strategies`, so it is already `unknown-strategy`.
 */
export const LOGIN_REFUSAL_REASONS = [
  'no-password',
  /** No strategy by that id is loaded — unknown, or configured off. */
  'unknown-strategy',
  'account-rate-limited',
  'bad-credentials',
  /** A provider asserted an address belonging to a system account (the seeded Guest row). */
  'system-account',
  'account-not-linked',
  'registration-disabled',
  'email-not-allowed',
  'inactive-user',
  'user-not-verified',
  /** The 2FA continuation could not be issued, or the required setup could not be started. */
  'tfa-failed',
  'tfa-incorrect-code',
  'tfa-recovery-codes-exhausted',
  /** The forced-password-change continuation could not be issued. */
  'change-password-failed',
  /** A 2FA continuation token that no longer resolves to an account. */
  'unknown-user'
] as const

export type LoginRefusalReason = (typeof LOGIN_REFUSAL_REASONS)[number]

/**
 * Deliberately narrow: no address, no submitted username, no password. What an unauthenticated
 * caller claimed to be is not evidence of anything and would land in the log verbatim; `user`
 * appears only where the account is already resolved and the credential already proven. The audit
 * table keeps the fuller record, under access control this log has none of.
 */
interface LoginRefusalContext {
  strategy?: string
  site?: string
  ip?: string
  user?: string
}

/**
 * An attempt with no address to key on shares one bucket rather than escaping coalescing entirely.
 */
function refusalLogKey(ip: string | undefined): string {
  return `auth:login-refused:${ip ?? 'unknown'}`
}

/**
 * The one place a refused login reaches the log: every branch that throws calls this rather than
 * writing its own line, which is what keeps `reason=` a countable vocabulary instead of a sentence.
 * The per-branch `authDebug` narration is the flag-gated story of one attempt; this is the
 * operator's countable record of the outcome.
 *
 * Coalesced over the authentication limiter's own window: the first few refusals from an address
 * are logged in full, and the rest fold into one summary line when the window closes.
 */
function logLoginRefused(reason: LoginRefusalReason, context: LoginRefusalContext = {}): void {
  const { ip, strategy } = context
  const logInFull = coalesce(refusalLogKey(ip), authRateLimitWindowMs(), (summary) => {
    CARDINAL.logger.warn(
      'auth',
      `login refused ${summary.total} times in ${Math.round(summary.windowMs / 1000)}s`,
      { ip, strategy }
    )
  })
  if (logInFull) {
    CARDINAL.logger.warn('auth', 'login refused', { reason, ...context })
  }
}

/**
 * The continuation token already proved the password, so unlike a fresh login's `bad-credentials`
 * refusal this may name the account directly. Deliberately not called from `loginTFA()`'s earlier
 * pre-checks (an unresolvable token, a mismatched strategy, the rate limiter) -- those refuse before
 * anything has actually been verified.
 */
async function recordTfaFailure(
  user: { id: string; name: string; email: string },
  strategyId: string,
  siteId: string,
  ip: string | undefined,
  reason: LoginRefusalReason
): Promise<void> {
  await CARDINAL.models.auditLog.record({
    event: 'login.failed',
    actor: { id: user.id, name: user.name, ip },
    targetType: 'user',
    targetId: user.id,
    targetLabel: user.email,
    detail: { strategyId, reason },
    siteId
  })
}

/**
 * IP and User-Agent collapse into one signal rather than being tracked separately: there is no geoIP
 * lookup here that could tell a "new location" from "a new IP on an otherwise unchanged network".
 * See `docs/decisions/2026-09-15-tfa-new-device-login-fingerprint.md`.
 */
function tfaDeviceFingerprint(ip: string | undefined, userAgent: string | undefined): string {
  return generateHash(`${ip ?? ''}|${userAgent ?? ''}`)
}

/**
 * Called once per successful code verification, `setup` completions included: an account's very
 * first fingerprint is, correctly, a new one.
 *
 * Two logins racing to record the same never-seen fingerprint resolve as "not new" for whichever
 * insert loses the unique-index race — it genuinely is known by then, so there is nothing for the
 * loser to newly report.
 */
async function checkAndRecordTfaDevice(
  userId: string,
  ip: string | undefined,
  userAgent: string | undefined
): Promise<boolean> {
  const fingerprint = tfaDeviceFingerprint(ip, userAgent)
  const existing = await CARDINAL.db
    .select({ id: tfaKnownDevices.id })
    .from(tfaKnownDevices)
    .where(and(eq(tfaKnownDevices.userId, userId), eq(tfaKnownDevices.fingerprint, fingerprint)))
    .limit(1)

  if (existing.length > 0) {
    await CARDINAL.db
      .update(tfaKnownDevices)
      .set({ lastSeenAt: sql`now()`, ip: ip ?? null, userAgent: userAgent ?? null })
      .where(eq(tfaKnownDevices.id, existing[0].id))
    return false
  }

  try {
    await CARDINAL.db.insert(tfaKnownDevices).values({
      userId,
      fingerprint,
      ip: ip ?? null,
      userAgent: userAgent ?? null
    })
    return true
  } catch (err: any) {
    if (isUniqueViolation(err)) {
      return false
    }
    throw err
  }
}

/**
 * One request's journey from a credential to a session. The account itself (`models/users.ts`) and
 * the credentials on it (`models/userCredentials.ts`) are separate models, because both are things
 * that exist between requests.
 */
class Login {
  async login(
    { siteId, strategyId, username, password, ip }: LoginOptions,
    req: any
  ): Promise<AfterLoginResult> {
    if (strategyId in CARDINAL.auth.strategies) {
      const str = CARDINAL.auth.strategies[strategyId] as any
      const strInfo = CARDINAL.data.authentication.find((a: any) => a.key === str.module)

      // -> Defense in depth: the route schema already requires `password`, but a form-based
      //    module's verification bind must not depend on that alone — the alternative is trusting
      //    every present and future `useForm` module to check it itself.
      if (strInfo.useForm && !password) {
        CARDINAL.models.flags.authDebug(
          `Login attempt on site ${siteId} using ${str.module} strategy ${strategyId} rejected: no password provided`
        )
        logLoginRefused('no-password', { strategy: strategyId, site: siteId, ip })
        throw new Error('ERR_LOGIN_FAILED')
      }

      const context = {
        ip,
        siteId,
        ...(strInfo.useForm && {
          username,
          password
        })
      }

      // -> Never the password, flag or no flag
      CARDINAL.models.flags.authDebug(
        `Login attempt on site ${siteId} using ${str.module} strategy ${strategyId}${username ? ` as "${username}"` : ''} from ${ip}`
      )

      /*
        Account-keyed bound, independent of `req.ip` -- which `helpers/rateLimit.ts#limitAuthAttempts`
        already bounds, but which a misconfigured `security.trustProxy` can leave client-spoofable per
        request. Only form-based strategies have a credential to guess here; a redirect-based provider
        never reaches this branch with a `username`. Checked before `str.authenticate()` so a tripped
        limit also saves the bcrypt/LDAP round trip.
      */
      if (strInfo.useForm && username) {
        const verdict = await consumeAccountAuthAttempt(username)
        if (!verdict.allowed) {
          CARDINAL.models.flags.authDebug(
            `Rate limit: refused login for account "${username}", ${verdict.retryAfter}s left of its ban.`
          )
          logLoginRefused('account-rate-limited', { strategy: strategyId, site: siteId, ip })
          throw new AccountRateLimitedError(verdict.retryAfter)
        }
      }

      let user
      try {
        user = await str.authenticate(context)
      } catch (err: any) {
        /*
          A form-based module (LDAP) verifies the person itself and never resolves a local user: it
          throws this once verification succeeds, whether or not an account already exists, so every
          login takes the same find-or-create path a redirect-based provider does -- which is also
          what re-syncs group membership. `autoProvision` is deliberately NOT re-checked here:
          `findOrCreateProviderUser()` enforces it for the only case that needs it (an unknown
          address), and gating here too would refuse a returning user the moment it is turned off.
          The flag means "accepts new users", not "accepts logins".
        */
        if (strInfo.useForm && err instanceof ProvisionableLoginError) {
          const providerStrategy = await CARDINAL.models.authentication.getStrategyById(strategyId)
          if (!providerStrategy) {
            throw new Error('ERR_INVALID_STRATEGY')
          }
          user = await this.findOrCreateProviderUser(providerStrategy, err.profile)
        } else {
          CARDINAL.models.flags.authDebug(
            `Strategy ${str.module} rejected the attempt${username ? ` for "${username}"` : ''}: ${err.message}`
          )
          logLoginRefused('bad-credentials', { strategy: strategyId, site: siteId, ip })
          // -> No user id: an attempt that failed authentication is not attributable to an account,
          //    only to whatever the caller claimed to be.
          await CARDINAL.models.auditLog.record({
            event: 'login.failed',
            actor: { id: null, name: username ?? '', ip },
            targetType: 'user',
            targetLabel: username ?? '',
            detail: { strategyId, reason: err.message },
            siteId
          })
          throw err
        }
      }

      return this.afterLoginChecks(
        user,
        strategyId,
        context,
        {
          skipTFA: !strInfo.useForm,
          skipChangePwd: !strInfo.useForm
        },
        req
      )
    } else {
      CARDINAL.models.flags.authDebug(
        `Login attempt using unknown strategy ${strategyId} from ${ip}`
      )
      logLoginRefused('unknown-strategy', { strategy: strategyId, site: siteId, ip })
      throw new Error('Invalid Strategy ID')
    }
  }

  /**
   * @throws `ERR_REGISTRATION_DISABLED`, `ERR_EMAIL_NOT_ALLOWED`, `ERR_ACCOUNT_NOT_LINKED`,
   *         `ERR_LOGIN_FAILED`, `ERR_INACTIVE_USER`
   */
  async loginWithProvider(
    {
      siteId,
      strategy,
      profile,
      ip
    }: {
      siteId: string
      strategy: AuthStrategy
      profile: ProviderProfile
      ip?: string
    },
    req: any
  ): Promise<AfterLoginResult> {
    const user = await this.findOrCreateProviderUser(strategy, profile)

    /*
      `mustChangePwd` lives on the local strategy's own auth entry and is about a stored password
      this login never touches, so it stays skipped. 2FA deliberately is not: a TOTP secret enrolled
      under the local strategy is the owner wanting a second factor regardless of which door they
      sign in through, so `afterLoginChecks()` still stops a provider login at `provideTfa` when one
      is active there -- independently of whatever MFA the provider itself performed.
    */
    return this.afterLoginChecks(user, strategy.id, { ip, siteId }, { skipChangePwd: true }, req)
  }

  /**
   * Skips everything a provider login does besides binding the identity: no group sync, no avatar
   * or name fill, and no session. The provider's address need not match the account's.
   *
   * @throws `ERR_EMAIL_NOT_ALLOWED`, `ERR_LINK_NOT_SIGNED_IN`, `ERR_LINK_ALREADY_LINKED` or
   *         `ERR_LINK_IDENTITY_IN_USE`
   */
  async linkProviderToAccount({
    userId,
    strategy,
    profile,
    siteId,
    ip
  }: {
    userId: string
    strategy: AuthStrategy
    profile: ProviderProfile
    siteId?: string
    ip?: string
  }): Promise<void> {
    const email = (profile.email ?? '').toLowerCase().trim()
    this.assertAllowedProviderEmail(strategy, email)
    const definition = CARDINAL.data.authentication?.find((d: any) => d.key === strategy.module)
    await CARDINAL.models.userCredentials.linkStrategy({
      userId,
      strategyId: strategy.id,
      identity: { id: profile.id, email },
      methodName: strategy.displayName || definition?.title || strategy.module,
      siteId,
      ip
    })
  }

  /**
   * Finds the account, creating and linking one if the strategy accepts new users — and syncs group
   * membership either way.
   *
   * Identity, once an account exists, is `profile.id` matched against the `auth[strategy.id].id` a
   * previous login stored — never the email address alone, and never a strategy other than this
   * exact one: a module must not be able to walk in and claim an account linked under a different
   * strategy. `trustEmailForLinking` is the explicit administrator opt-in that waives that for a
   * provider whose address is verified.
   *
   * `isActive`/`isVerified` are deliberately not checked here: both callers hand the returned user
   * straight to `afterLoginChecks()`, which is the one place that check belongs.
   *
   * @throws `ERR_REGISTRATION_DISABLED`, `ERR_EMAIL_NOT_ALLOWED`, `ERR_ACCOUNT_NOT_LINKED`,
   *         `ERR_LOGIN_FAILED`
   */
  private async findOrCreateProviderUser(
    strategy: AuthStrategy,
    profile: ProviderProfile
  ): Promise<any> {
    const email = profile.email.toLowerCase().trim()
    const firstName = (profile.firstName ?? '').trim()
    const lastName = (profile.lastName ?? '').trim()
    // -> The stored link first: a provider connected through `linkProviderToAccount()` may report
    //    an address that belongs to nobody, or to a different account.
    let user =
      (await CARDINAL.models.users.getByProviderLink(strategy.id, profile.id)) ??
      (await CARDINAL.models.users.getByEmail(email))

    // -> Before anything else: a system account (the seeded Guest row) must never be reachable
    //    through a provider, and neither `getByProviderLink()` nor `getByEmail()` filters
    //    `isSystem`.
    if (user?.isSystem) {
      CARDINAL.models.flags.authDebug(
        `Provider login for <${email}> refused: address belongs to a system account`
      )
      logLoginRefused('system-account', { strategy: strategy.id })
      throw new Error('ERR_LOGIN_FAILED')
    }

    // -> Only the moment a previously-unlinked account gets linked via `trustEmailForLinking` --
    //    never for an account already linked, a brand-new one, or a re-write of an existing link.
    let justRelinkedViaTrustedEmail = false

    if (user) {
      const auth = (user.auth ?? {}) as Record<string, any>
      const linkedId = auth[strategy.id]?.id
      if (linkedId === undefined) {
        if (!strategy.trustEmailForLinking) {
          CARDINAL.models.flags.authDebug(
            `Provider login for <${email}> refused: no stored account link for strategy ${strategy.id}, and trustEmailForLinking is off`
          )
          logLoginRefused('account-not-linked', { strategy: strategy.id })
          throw new Error('ERR_ACCOUNT_NOT_LINKED')
        }
        justRelinkedViaTrustedEmail = true
      } else if (linkedId !== profile.id) {
        CARDINAL.models.flags.authDebug(
          `Provider login for <${email}> refused: profile id does not match the account link stored for strategy ${strategy.id}`
        )
        logLoginRefused('account-not-linked', { strategy: strategy.id })
        throw new Error('ERR_ACCOUNT_NOT_LINKED')
      }
      // -> Applied on every login, not only account creation: turning the pattern down after an
      //    account was linked under a looser one must not leave that account grandfathered in.
      this.assertAllowedProviderEmail(strategy, email, { strategy: strategy.id })
    } else {
      if (!strategy.autoProvision) {
        CARDINAL.models.flags.authDebug(
          `Provider login for unknown address <${email}> refused: strategy ${strategy.id} does not accept new users`
        )
        logLoginRefused('registration-disabled', { strategy: strategy.id })
        throw new Error('ERR_REGISTRATION_DISABLED')
      }
      this.assertAllowedProviderEmail(strategy, email, { strategy: strategy.id })
      const userId = await CARDINAL.models.users.createUser({
        // -> The halves win when the provider issued either: passing them alongside `name` would
        //    mark the row locally edited whenever the display name is not exactly `first last`
        //    ("Dr. Alice Example"), permanently freezing the derivation.
        ...(firstName || lastName ? { firstName, lastName } : { name: profile.name || email }),
        email,
        // -> Nothing signs in with it: this account authenticates at the provider, and the local
        //    strategy's own entry is what a password would live under.
        password: randomToken(24),
        groups: strategy.autoEnrollGroups ?? [],
        isVerified: true
      })
      user = await CARDINAL.models.users.getById(userId)
      CARDINAL.models.flags.authDebug(
        `Created user ${userId} <${email}> from ${strategy.module} strategy ${strategy.id}`
      )
    }

    if (!user) {
      throw new Error('ERR_LOGIN_FAILED')
    }

    // -> Written on every login, not only at creation: this entry is also what tells the profile
    //    page that the user signs in through this strategy.
    await CARDINAL.models.userCredentials.patchStrategyAuth(
      user.id,
      strategy.id,
      () => ({ id: profile.id, email }),
      {
        mirrorInto: user
      }
    )

    if (justRelinkedViaTrustedEmail) {
      await this.clearMigratedFallbackLocalAuth(user)
    }

    await this.fillMissingNameHalves(user, firstName, lastName)

    // -> Every login, not only the one that created the account: a group added or removed at the
    //    provider since the last login has to show up here too.
    if (strategy.config?.mapGroups && profile.groups) {
      await this.syncProviderGroups(user, strategy, profile.groups)
    }

    if (profile.picture) {
      await CARDINAL.models.users.syncAvatarFromProvider(user.id, profile.picture)
    }

    return user
  }

  /**
   * Only an EMPTY half is written. A populated one is left exactly as it is, whoever put it there,
   * which is what makes a locally corrected name survive every subsequent sign-in.
   *
   * `nameLocallyEdited` is deliberately absent from the patch: `updateUser()` owns that rule, so
   * setting the marker here would be a second owner of the decision and clearing it would let a
   * provider quietly undo somebody's edit.
   *
   * The row is re-read and merged back onto `user` rather than the patch being assigned onto it,
   * because `updateUser()` also re-derives `name` — the caller returns this same object, and its
   * `afterLoginChecks()` reads `name` onto the session.
   */
  private async fillMissingNameHalves(
    user: any,
    firstName: string,
    lastName: string
  ): Promise<void> {
    const patch: { firstName?: string; lastName?: string } = {}
    if (firstName && !user.firstName) {
      patch.firstName = firstName
    }
    if (lastName && !user.lastName) {
      patch.lastName = lastName
    }
    if (Object.keys(patch).length === 0) {
      return
    }
    await CARDINAL.models.users.updateUser(user.id, patch)
    const refreshed = await CARDINAL.models.users.getById(user.id)
    if (refreshed) {
      Object.assign(user, refreshed)
    }
  }

  /**
   * Once a migrated fallback account relinks to its real identity provider, the orphaned
   * local-strategy auth entry `createProviderFallbackUserConverter()` wrote for it (a random,
   * unknowable password plus `mustChangePwd: true`) has nothing left to protect and nothing left to
   * prompt for. Left alone it keeps showing up everywhere `mustChangePwd` is read as "needs a
   * password reset".
   *
   * Gated on `auth[localStrategyId].migratedFallbackProvider` rather than on `mustChangePwd` alone:
   * an admin-forced reset on a genuine local account is stored as `mustChangePwd: true` too, so
   * clearing on that alone would let a login through SSO silently cancel a reset an administrator
   * deliberately imposed. Without the marker this is correctly a no-op — there is no other way to
   * tell the two cases apart.
   */
  private async clearMigratedFallbackLocalAuth(user: { id: string; auth: unknown }): Promise<void> {
    const localStrategyId = CARDINAL.data.systemIds.localAuthId
    const localAuth = ((user.auth ?? {}) as Record<string, any>)[localStrategyId]
    if (!localAuth?.migratedFallbackProvider) {
      return
    }

    await CARDINAL.models.userCredentials.patchStrategyAuth(
      user.id,
      localStrategyId,
      () => ({ mustChangePwd: false, migratedFallbackProvider: undefined }),
      { mirrorInto: user }
    )

    CARDINAL.models.flags.authDebug(
      `Cleared the stale migrated-fallback local auth entry for user ${user.id} after it relinked via a trusted-email provider`
    )
  }

  /**
   * @param refusalContext Present only when this guard runs inside a login, where a refusal is a
   *   login outcome and gets a `login refused` line. `register()` passes none: a self-registration
   *   turned away for its address never had a session behind it, and counting it would distort what
   *   an operator reads as failed sign-ins.
   * @throws `ERR_EMAIL_NOT_ALLOWED` when the strategy has a pattern and the address does not match it.
   */
  private assertAllowedProviderEmail(
    strategy: AuthStrategy,
    email: string,
    refusalContext?: LoginRefusalContext
  ): void {
    if (!strategy.allowedEmailRegex) {
      return
    }
    // -> Compiled but never used: this exists only to keep the "invalid pattern" warn informative
    //    for a legacy strategy saved before `models/authentication.ts#validateStrategy` checked
    //    syntax, and plays no part in the allow/deny decision below.
    try {
      new RegExp(strategy.allowedEmailRegex)
    } catch (err: any) {
      CARDINAL.logger.warn('auth', 'strategy has an invalid email pattern, refusing', {
        strategy: strategy.id,
        error: err
      })
    }
    // -> Bounds both the string tested and the time spent testing it, so a catastrophic-backtracking
    //    pattern saved before the save-time check existed cannot hang the event loop. It answers
    //    `false` for an unparseable pattern: one that cannot be trusted allows nobody, not everybody.
    const allowed = testRegexSafely(strategy.allowedEmailRegex, email)
    if (!allowed) {
      if (refusalContext) {
        logLoginRefused('email-not-allowed', refusalContext)
      }
      throw new Error('ERR_EMAIL_NOT_ALLOWED')
    }
  }

  /**
   * Local self-registration's own domain allow-list, distinct from `allowedEmailRegex` above, which
   * also gates provider auto-provisioning; this is scoped to `register()` alone. Empty means
   * unrestricted. `strategy.allowedEmailDomains` is already lowercased and trimmed at write time
   * (`models/authentication.ts#normalizeEmailDomains`), so only the incoming address needs folding.
   *
   * @throws `ERR_EMAIL_NOT_ALLOWED` when the list is non-empty and the address's domain is not on it.
   */
  private assertAllowedRegistrationDomain(strategy: AuthStrategy, email: string): void {
    if (!strategy.allowedEmailDomains || strategy.allowedEmailDomains.length < 1) {
      return
    }
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
    if (!strategy.allowedEmailDomains.includes(domain)) {
      CARDINAL.models.flags.authDebug(
        `Registration refused: domain <${domain}> is not on strategy ${strategy.id}'s allowed list`
      )
      throw new Error('ERR_EMAIL_NOT_ALLOWED')
    }
  }

  /**
   * Four memberships are never touched, whatever the provider reported:
   *
   *   - the guests group: anonymous access itself, not something a provider grants a real account;
   *   - a group the strategy's own `autoEnrollGroups` still grants — an administrator put that grant
   *     there directly, and a provider that stopped mentioning it should not silently undo it;
   *   - every `manage:system` group and the configured root administrators group: an IdP can never
   *     grant or revoke wiki-level administrative access, the same invariant `api/users/admin.ts`
   *     enforces for a human editing membership directly. Holds independently of the allow-list;
   *   - anything outside `mappableGroups`, the admin-chosen subset this strategy may touch at all.
   *     It defaults to empty, so an unconfigured strategy changes no memberships on login.
   */
  async syncProviderGroups(
    user: { id: string },
    strategy: AuthStrategy,
    reportedGroups: string[]
  ): Promise<void> {
    const guestsGroupId = CARDINAL.data.systemIds.guestsGroupId
    const rootAdminGroupId = CARDINAL.config.auth.rootAdminGroupId
    const systemGroupIds = await CARDINAL.models.groups.systemGroupIds()
    const neverMapped = new Set([guestsGroupId, rootAdminGroupId, ...systemGroupIds])
    const mappable = new Set(strategy.mappableGroups ?? [])
    // -> Which of the currently-held allow-listed groups this login may take away. Shared with
    //    `models/authentication.ts#getGroupSyncWarnings()`, the admin-facing read that warns before
    //    the same exclusion bites a manual grant -- keep the two on one helper.
    const revocable = new Set(
      syncRevocableGroupIds(strategy, { guestsGroupId, rootAdminGroupId, systemGroupIds })
    )

    const reportedNames = new Set(
      reportedGroups.map((name) => name.trim().toLowerCase()).filter(Boolean)
    )
    const allGroups = await CARDINAL.models.groups.getAllGroups()
    const matchedGroupIds = new Set(
      allGroups
        .filter(
          (g: any) =>
            !neverMapped.has(g.id) &&
            mappable.has(g.id) &&
            reportedNames.has(g.name.trim().toLowerCase())
        )
        .map((g: any) => g.id)
    )

    const currentGroupIds = await CARDINAL.models.users.getUserGroupIds(user.id)
    const currentSet = new Set(currentGroupIds)

    const toAdd = [...matchedGroupIds].filter((id) => !currentSet.has(id))
    // -> `revocable`, not `mappable`: it already excludes what the allow-list would let through but
    //    must never be taken away (guests, system/root-admin, anything also `autoEnrollGroups`).
    const toRemove = currentGroupIds.filter((id) => revocable.has(id) && !matchedGroupIds.has(id))

    if (toAdd.length < 1 && toRemove.length < 1) {
      return
    }

    for (const groupId of toAdd) {
      await CARDINAL.models.groups.assignUserToGroup(groupId, user.id)
    }
    for (const groupId of toRemove) {
      await CARDINAL.models.groups.unassignUserFromGroup(groupId, user.id)
    }

    CARDINAL.models.flags.authDebug(
      `Synced provider groups for user ${user.id} via strategy ${strategy.id}: +${toAdd.length} / -${toRemove.length}`
    )
  }

  /**
   * Self-registration through a form-based strategy.
   *
   * An address stuck unverified is not a dead end: registering again resends the link rather than
   * refusing, since nobody else could have claimed it in the meantime (an unverified account cannot
   * log in). The submitted `name` and `password` are ignored on that path, so registering somebody
   * else's still-pending address cannot overwrite its password.
   *
   * With `emailValidation` on, an address that already has a *verified* account also answers the
   * generic `{ nextAction: 'verify' }` and emails the real owner a notice instead -- mirroring
   * `forgotPassword()`'s address-enumeration design, without which one unauthenticated attempt would
   * confirm whether an address has an account here. With it off there is no email step to route that
   * secrecy through, so a colliding address keeps throwing `ERR_EMAIL_ALREADY_EXISTS`.
   *
   * @throws `ERR_INVALID_STRATEGY`, `ERR_REGISTRATION_DISABLED`, `ERR_EMAIL_ALREADY_EXISTS`,
   *         `ERR_EMAIL_NOT_ALLOWED`
   */
  async register(
    {
      siteId,
      strategyId,
      name,
      firstName,
      lastName,
      email,
      password,
      ip
    }: {
      siteId: string
      strategyId: string
      /** An explicitly authored display name; the sign-up form sends the two halves instead. */
      name?: string
      firstName?: string
      lastName?: string
      email: string
      password: string
      ip?: string
    },
    req: any
  ): Promise<RegisterResult> {
    const strategy = await CARDINAL.models.authentication.getStrategyById(strategyId)
    if (!strategy || !strategy.isEnabled) {
      CARDINAL.models.flags.authDebug(`Registration attempt against unknown strategy ${strategyId}`)
      throw new Error('ERR_INVALID_STRATEGY')
    }

    // -> `createUser()` always writes the submitted password under the local strategy, so accepting
    //    this against a redirect-based provider would mint a permanent local account for an identity
    //    that provider was supposed to own. Only a form-based module verifies what it is handed.
    const authModule = CARDINAL.data.authentication.find((a: any) => a.key === strategy.module)
    if (!authModule?.useForm) {
      CARDINAL.models.flags.authDebug(
        `Registration refused: strategy ${strategy.id} (${strategy.module}) is not a form-based module`
      )
      throw new Error('ERR_INVALID_STRATEGY')
    }

    // -> A strategy exists globally the moment it is configured, but only accepts requests through
    //    the sites an administrator attached it to.
    const site = await CARDINAL.models.sites.getSiteById({ id: siteId })
    const attachedToSite = (site?.config?.authStrategies ?? []).some(
      (s: any) => s.id === strategyId
    )
    if (!attachedToSite) {
      CARDINAL.models.flags.authDebug(
        `Registration refused: strategy ${strategy.id} is not attached to site ${siteId}`
      )
      throw new Error('ERR_INVALID_STRATEGY')
    }

    if (!strategy.selfRegistration) {
      CARDINAL.models.flags.authDebug(
        `Registration refused: strategy ${strategy.id} does not accept new users`
      )
      throw new Error('ERR_REGISTRATION_DISABLED')
    }

    const normalizedEmail = email.toLowerCase().trim()

    // -> Before the existing-account lookup below: a domain refusal is a blanket rule about the
    //    domain, so checking it first reveals nothing about whether the address has an account here.
    this.assertAllowedRegistrationDomain(strategy, normalizedEmail)

    const requiresVerification = Boolean(strategy.config?.emailValidation)
    const existing = await CARDINAL.models.users.getByEmail(normalizedEmail)

    if (existing) {
      if (!requiresVerification) {
        // -> No email step to route the secrecy through on this strategy.
        throw new Error('ERR_EMAIL_ALREADY_EXISTS')
      }
      if (!existing.isVerified) {
        CARDINAL.models.flags.authDebug(
          `Registration for <${normalizedEmail}> matched an unverified account, resending the verification email`
        )
        const token = await CARDINAL.models.userCredentials.generateToken({
          kind: 'verify',
          userId: existing.id
        })
        await CARDINAL.models.mail.sendVerifyEmail({
          to: existing.email,
          name: existing.name,
          token,
          userId: existing.id,
          siteId
        })
        return { nextAction: 'verify' }
      }
      // -> A verified account already sits here, and the generic `{ nextAction: 'verify' }` below is
      //    what keeps the response from confirming that; the real owner gets a notice instead.
      CARDINAL.models.flags.authDebug(
        `Registration for <${normalizedEmail}> matched an existing verified account; notifying instead of confirming`
      )
      try {
        await CARDINAL.models.mail.sendRegistrationAttemptNotice({
          to: existing.email,
          name: existing.name,
          userId: existing.id,
          locale: (existing.prefs as Record<string, any> | undefined)?.locale,
          siteId
        })
      } catch (err: any) {
        CARDINAL.logger.warn('auth', 'sending the registration-attempt notice failed', {
          user: existing.id,
          error: err
        })
      }
      return { nextAction: 'verify' }
    }

    this.assertAllowedProviderEmail(strategy, normalizedEmail)

    // -> Resolved here only so the verification email below can address the account; `createUser`
    //    still receives the raw three fields. Not a second derivation -- the same composer.
    const displayName = name ?? deriveDisplayName(firstName ?? '', lastName ?? '')

    const userId = await CARDINAL.models.users.createUser({
      name,
      firstName,
      lastName,
      email: normalizedEmail,
      password,
      groups: strategy.autoEnrollGroups ?? [],
      isVerified: !requiresVerification
    })
    CARDINAL.models.flags.authDebug(
      `Registered user ${userId} <${normalizedEmail}> via ${strategy.module} strategy ${strategy.id}, verification ${requiresVerification ? 'required' : 'not required'}`
    )
    await CARDINAL.models.auditLog.record({
      event: 'user.registered',
      actor: { id: userId, name: displayName, email: normalizedEmail, ip },
      targetType: 'user',
      targetId: userId,
      targetLabel: normalizedEmail,
      detail: { strategyId: strategy.id, verificationRequired: requiresVerification },
      siteId
    })

    if (requiresVerification) {
      const token = await CARDINAL.models.userCredentials.generateToken({ kind: 'verify', userId })
      await CARDINAL.models.mail.sendVerifyEmail({
        to: normalizedEmail,
        name: displayName,
        token,
        userId,
        siteId
      })
      return { nextAction: 'verify' }
    }

    const user = await CARDINAL.models.users.getById(userId)
    if (!user) {
      throw new Error('ERR_REGISTRATION_FAILED')
    }
    return this.afterLoginChecks(
      user,
      strategy.id,
      { ip, siteId },
      { skipTFA: true, skipChangePwd: true },
      req
    )
  }

  async afterLoginChecks(
    user: any,
    strategyId: string,
    context: any,
    { skipTFA, skipChangePwd }: { skipTFA?: boolean; skipChangePwd?: boolean } = {
      skipTFA: false,
      skipChangePwd: false
    },
    req?: any
  ): Promise<AfterLoginResult> {
    // -> The credential is already proven by the time anything reaches this method, so unlike the
    //    refusals in `login()` these may name the account they are about.
    const refusalContext: LoginRefusalContext = {
      strategy: strategyId,
      site: context?.siteId,
      ip: context?.ip,
      user: user?.id
    }

    const str = CARDINAL.auth.strategies[strategyId] as any
    if (!str) {
      logLoginRefused('unknown-strategy', refusalContext)
      throw new Error('ERR_INVALID_STRATEGY')
    }

    // -> Every login path ends in this method, so this is the one place an account-state check is
    //    guaranteed to run. `restrictLogin` is deliberately NOT checked here: it is a per-strategy
    //    local-only flag, already enforced by the local module's `authenticate()` and by
    //    `forgotPassword()` before a reset token is minted.
    if (!user.isActive) {
      logLoginRefused('inactive-user', refusalContext)
      throw new Error('ERR_INACTIVE_USER')
    }
    if (!user.isVerified) {
      logLoginRefused('user-not-verified', refusalContext)
      throw new Error('ERR_USER_NOT_VERIFIED')
    }

    user.groups = await CARDINAL.db.query.users
      .findFirst({
        columns: {},
        where: {
          id: user.id
        },
        with: {
          groups: {
            columns: {
              id: true,
              permissions: true,
              redirectOnLogin: true
            }
          }
        }
      })
      .then((r: any) => r?.groups || [])

    let redirect = '/'
    if (user.groups && user.groups.length > 0) {
      for (const grp of user.groups as any[]) {
        if (grp.redirectOnLogin && grp.redirectOnLogin !== '/') {
          redirect = grp.redirectOnLogin
          break
        }
      }
    }

    const authStr = user.auth[strategyId] || {}

    if (!skipTFA) {
      /*
        A TOTP secret enrolled under the local strategy gates every login for the account, not just
        one made through the local strategy itself: enrolling it is the owner's deliberate choice,
        made independently of which door they use next. Without this fallback a provider login --
        whose own `auth[strategyId]` entry almost never has a secret -- would sail straight past a
        second factor the owner explicitly turned on.
      */
      const localStrategyId = CARDINAL.data.systemIds.localAuthId
      const localAuthStr =
        strategyId !== localStrategyId ? (user.auth?.[localStrategyId] as any) || {} : authStr
      const usesLocalFallback =
        !(authStr.tfaIsActive && authStr.tfaSecret) &&
        localAuthStr.tfaIsActive &&
        localAuthStr.tfaSecret
      const tfaStrategyId = usesLocalFallback ? localStrategyId : strategyId
      const tfaAuthStr = usesLocalFallback ? localAuthStr : authStr

      if (tfaAuthStr.tfaIsActive && tfaAuthStr.tfaSecret) {
        try {
          const tfaToken = await CARDINAL.models.userCredentials.generateToken({
            kind: 'tfa',
            userId: user.id,
            meta: {
              strategyId,
              tfaStrategyId
            }
          })
          CARDINAL.models.flags.authDebug(
            `User ${user.id} <${user.email}> authenticated, but a 2FA code is required first`
          )
          return {
            nextAction: 'provideTfa',
            continuationToken: tfaToken,
            redirect
          }
        } catch (errc: any) {
          CARDINAL.logger.warn('auth', 'issuing the 2FA continuation failed', {
            user: user.id,
            strategy: strategyId,
            error: errc
          })
          logLoginRefused('tfa-failed', refusalContext)
          throw new Error('ERR_TFA_FAILED')
        }
      } else if (str.config?.enforceTfa || authStr.tfaRequired) {
        try {
          const { tfaQRImage } = await CARDINAL.models.userCredentials.startTfaSetup(
            user,
            strategyId,
            context.siteId
          )
          const tfaToken = await CARDINAL.models.userCredentials.generateToken({
            kind: 'tfaSetup',
            userId: user.id,
            meta: {
              strategyId
            }
          })
          CARDINAL.models.flags.authDebug(
            `User ${user.id} <${user.email}> authenticated, but must set up 2FA first`
          )
          return {
            nextAction: 'setupTfa',
            continuationToken: tfaToken,
            tfaQRImage,
            redirect
          }
        } catch (errc: any) {
          CARDINAL.logger.warn('auth', 'starting the 2FA setup failed', {
            user: user.id,
            strategy: strategyId,
            error: errc
          })
          logLoginRefused('tfa-failed', refusalContext)
          throw new Error('ERR_TFA_FAILED')
        }
      }
    }

    if (!skipChangePwd && authStr.mustChangePwd) {
      try {
        const pwdChangeToken = await CARDINAL.models.userCredentials.generateToken({
          kind: 'changePwd',
          userId: user.id,
          meta: {
            strategyId
          }
        })

        CARDINAL.models.flags.authDebug(
          `User ${user.id} <${user.email}> authenticated, but must change their password first`
        )
        return {
          nextAction: 'changePassword',
          continuationToken: pwdChangeToken,
          redirect
        }
      } catch (errc: any) {
        CARDINAL.logger.warn('auth', 'issuing the change-password continuation failed', {
          user: user.id,
          strategy: strategyId,
          error: errc
        })
        logLoginRefused('change-password-failed', refusalContext)
        throw new Error('ERR_CHANGE_PASSWORD_FAILED')
      }
    }

    await CARDINAL.models.users.updateSession(user, req)

    CARDINAL.models.flags.authDebug(
      `User ${user.id} <${user.email}> logged in with ${user.groups.length} group(s) and ${req?.session?.permissions?.length ?? 0} permission(s), redirecting to ${redirect}`
    )

    // -> Only once the login has actually succeeded: an attempt stopped by 2FA or a forced password
    //    change is not a login yet. `updatedAt` is deliberately left alone -- signing in is not an
    //    edit of the account.
    await CARDINAL.db
      .update(usersTable)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(usersTable.id, user.id))

    // -> A login has no site context, so a site-scoped hook must not receive one.
    await CARDINAL.models.hooks.emit('user:login', null, {
      userId: user.id,
      strategyId,
      ip: context.ip,
      metadata: {
        name: user.name,
        email: user.email
      }
    })

    // -> The counterpart the `login refused` lines are read against: a log showing only refusals
    //    cannot answer "did they eventually get in". Never coalesced — a burst of successful logins
    //    is not noise. Ids only, as with a refusal: the address and display name belong to the
    //    audit row, not the log.
    CARDINAL.logger.info('auth', 'login', {
      user: user.id,
      strategy: strategyId,
      site: context.siteId ?? null
    })

    await CARDINAL.models.auditLog.record({
      event: 'login.success',
      actor: { id: user.id, name: user.name, ip: context.ip },
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      detail: { strategyId },
      siteId: context.siteId ?? null
    })

    return {
      authenticated: true,
      nextAction: 'redirect',
      redirect
    }
  }

  /**
   * Finish a login that stopped for 2FA — either to ask for a code, or to have the user set 2FA up
   * because the strategy or the account requires it.
   *
   * The continuation token is kept rather than consumed while codes are being tried: a mistyped or
   * just-expired code has to be retryable. It is destroyed here as soon as one is correct, and by
   * `countTfaFailure()` once too many have not been.
   *
   * @param setup True when the token came from a required setup, in which case a correct code also
   *              activates the secret that was generated for it.
   * @throws `ERR_TFA_INVALID_REQUEST`, `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY`,
   *         `ERR_TFA_RECOVERY_CODES_EXHAUSTED` or `ERR_TFA_INCORRECT_TOKEN`, plus whatever
   *         `validateToken()` raises for a token that is unknown or expired
   */
  async loginTFA(
    {
      strategyId,
      siteId,
      securityCode,
      continuationToken,
      setup = false,
      ip
    }: {
      strategyId: string
      siteId: string
      securityCode: string
      continuationToken: string
      setup?: boolean
      ip?: string
    },
    req: any
  ): Promise<AfterLoginResult> {
    const isTotpShape = /^[0-9]{6}$/.test(securityCode)
    // -> Recovery codes only exist once 2FA is active, so none can answer a `setupTfa` login.
    const isRecoveryShape = !setup && isRecoveryCodeShape(securityCode)
    if (!continuationToken || (!isTotpShape && !isRecoveryShape)) {
      throw new Error('ERR_TFA_INVALID_REQUEST')
    }

    const {
      user,
      strategyId: expectedStrategyId,
      tfaStrategyId
    } = await CARDINAL.models.userCredentials.validateToken({
      kind: setup ? 'tfaSetup' : 'tfa',
      token: continuationToken,
      skipDelete: true
    })
    if (!user) {
      logLoginRefused('unknown-user', { strategy: strategyId, site: siteId, ip })
      throw new Error('ERR_INVALID_USER')
    }
    // -> The continuation token proves the password was already right, so what is left to guess is
    //    the TOTP or recovery code. Into the same `auth:user:` bucket as `login()`'s own call: code
    //    guessing is bounded together with password guessing, not as a separate budget.
    const verdict = await consumeAccountAuthAttempt(user.email)
    if (!verdict.allowed) {
      CARDINAL.models.flags.authDebug(
        `Rate limit: refused 2FA attempt for user ${user.id} <${user.email}>, ${verdict.retryAfter}s left of its ban.`
      )
      logLoginRefused('account-rate-limited', {
        strategy: strategyId,
        site: siteId,
        ip,
        user: user.id
      })
      throw new AccountRateLimitedError(verdict.retryAfter)
    }
    if (strategyId !== expectedStrategyId) {
      logLoginRefused('unknown-strategy', { strategy: strategyId, site: siteId, ip, user: user.id })
      throw new Error('ERR_INVALID_STRATEGY')
    }

    // -> The strategy whose secret actually gates this login: ordinarily the one just logged in
    //    with, but a provider login stopped by a locally-enrolled secret records which strategy's
    //    secret that was, since it is not this one.
    const verifyStrategyId = tfaStrategyId || strategyId

    let verified: boolean
    if (isTotpShape) {
      verified = await CARDINAL.models.userCredentials.verifyTfaCode(
        user,
        verifyStrategyId,
        securityCode
      )
    } else {
      const auth = (user.auth ?? {}) as Record<string, any>
      const entries = (auth[verifyStrategyId]?.recoveryCodes ?? []) as RecoveryCodeEntry[]
      // -> Distinguished from a plain wrong code: the client's response to "you mistyped it" and
      //    "you have nothing left to try" should not be the same generic rejection.
      if (entries.every((entry) => entry.usedAt)) {
        logLoginRefused('tfa-recovery-codes-exhausted', {
          strategy: strategyId,
          site: siteId,
          ip,
          user: user.id
        })
        await recordTfaFailure(user, strategyId, siteId, ip, 'tfa-recovery-codes-exhausted')
        throw new Error('ERR_TFA_RECOVERY_CODES_EXHAUSTED')
      }
      verified = await CARDINAL.models.userCredentials.verifyAndConsumeRecoveryCode(
        user,
        verifyStrategyId,
        securityCode
      )
    }
    if (!verified) {
      await countTfaFailure(continuationToken)
      CARDINAL.models.flags.authDebug(
        `User ${user.id} <${user.email}> submitted an incorrect 2FA code`
      )
      logLoginRefused('tfa-incorrect-code', {
        strategy: strategyId,
        site: siteId,
        ip,
        user: user.id
      })
      await recordTfaFailure(user, strategyId, siteId, ip, 'tfa-incorrect-code')
      throw new Error('ERR_TFA_INCORRECT_TOKEN')
    }

    await CARDINAL.models.userCredentials.destroyToken({ token: continuationToken })

    // -> A failure recording the device fingerprint, or sending the resulting notice, must not turn
    //    an otherwise-verified 2FA login into a rejected one.
    try {
      const uaHeader = req?.headers?.['user-agent']
      const userAgent = Array.isArray(uaHeader) ? uaHeader[0] : uaHeader
      const isNewDevice = await checkAndRecordTfaDevice(user.id, ip, userAgent)
      if (isNewDevice) {
        await CARDINAL.models.mail.sendTfaNewDeviceLogin({
          to: user.email,
          name: user.name,
          ip,
          userId: user.id,
          locale: user.prefs?.locale,
          siteId
        })
      }
    } catch (err: any) {
      CARDINAL.logger.warn(
        'auth',
        'recording the 2FA login device or sending its new-device notice failed',
        { user: user.id, strategy: strategyId, error: err }
      )
    }

    let recoveryCodes: string[] | undefined
    if (setup) {
      recoveryCodes = await CARDINAL.models.userCredentials.enableTfa(user, strategyId, siteId, ip)
    }

    // -> The remaining checks still apply: a user who owed a password change before 2FA still owes it
    const result = await this.afterLoginChecks(
      user,
      strategyId,
      { ip, siteId },
      { skipTFA: true },
      req
    )
    return recoveryCodes ? { ...result, recoveryCodes } : result
  }

  /**
   * Start 2FA setup from the profile page, for a user who is already logged in.
   *
   * @returns The QR code, the secret behind it for manual entry, and the token `confirmTfaSetup()`
   *          expects back
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY` or `ERR_TFA_ALREADY_ACTIVE`
   */
  async startProfileTfaSetup({
    userId,
    strategyId,
    siteId
  }: {
    userId: string
    strategyId: string
    siteId?: string
  }): Promise<{ continuationToken: string; tfaQRImage: string; tfaSecret: string }> {
    const { user, entry } = await CARDINAL.models.userCredentials.requireStrategyAuth(
      userId,
      strategyId
    )
    // -> Replacing a working secret would silently invalidate the app entry the user already has;
    //    turning 2FA off first is the way to start again.
    if (entry.tfaIsActive) {
      throw new Error('ERR_TFA_ALREADY_ACTIVE')
    }

    const { secret, tfaQRImage } = await CARDINAL.models.userCredentials.startTfaSetup(
      user,
      strategyId,
      siteId
    )
    const continuationToken = await CARDINAL.models.userCredentials.generateToken({
      kind: 'tfaSetup',
      userId,
      meta: { strategyId }
    })
    return { continuationToken, tfaQRImage, tfaSecret: secret }
  }

  /**
   * Finish 2FA setup from the profile page: check a code from the user's authenticator, then activate
   * the secret that was generated for it.
   *
   * Deliberately not `loginTFA()` with `setup`: the user is already logged in, and running the login
   * checks again would rebuild the session and emit a second login event for one visit.
   *
   * @returns The fresh recovery codes in plaintext — the only time they are ever available
   * @throws `ERR_TFA_INVALID_REQUEST`, `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY` or
   *         `ERR_TFA_INCORRECT_TOKEN`
   */
  async confirmTfaSetup({
    userId,
    strategyId,
    continuationToken,
    securityCode,
    ip
  }: {
    userId: string
    strategyId: string
    continuationToken: string
    securityCode: string
    ip?: string
  }): Promise<{ recoveryCodes: string[] }> {
    if (!continuationToken || !/^[0-9]{6}$/.test(securityCode)) {
      throw new Error('ERR_TFA_INVALID_REQUEST')
    }

    const { user, strategyId: expectedStrategyId } =
      await CARDINAL.models.userCredentials.validateToken({
        kind: 'tfaSetup',
        token: continuationToken,
        skipDelete: true
      })
    // -> The token is a bearer credential, so it only counts for the session that asked for it.
    if (!user || user.id !== userId) {
      throw new Error('ERR_INVALID_USER')
    }
    if (strategyId !== expectedStrategyId) {
      throw new Error('ERR_INVALID_STRATEGY')
    }
    if (!(await CARDINAL.models.userCredentials.verifyTfaCode(user, strategyId, securityCode))) {
      await countTfaFailure(continuationToken)
      throw new Error('ERR_TFA_INCORRECT_TOKEN')
    }

    await CARDINAL.models.userCredentials.destroyToken({ token: continuationToken })
    const recoveryCodes = await CARDINAL.models.userCredentials.enableTfa(
      user,
      strategyId,
      undefined,
      ip
    )
    return { recoveryCodes }
  }

  /**
   * A group's own target wins over the site's, which is what the admin area promises: the site
   * setting says it "can be overridden at the group level". With several groups the first one that
   * names a target wins, the same arbitrary-but-stable rule the login redirect uses.
   */
  async getLogoutRedirect(userId: string | null, siteId?: string): Promise<string> {
    if (userId) {
      const groups = await CARDINAL.db.query.users
        .findFirst({
          columns: {},
          where: {
            id: userId
          },
          with: {
            groups: {
              columns: {
                redirectOnLogout: true
              }
            }
          }
        })
        .then((r: any) => r?.groups ?? [])
      for (const grp of groups as any[]) {
        if (grp.redirectOnLogout && grp.redirectOnLogout !== '/') {
          return grp.redirectOnLogout
        }
      }
    }

    const site = siteId ? await CARDINAL.models.sites.getSiteById({ id: siteId }) : null
    return site?.config?.auth?.logoutRedirect || '/'
  }

  async loginChangePassword(
    {
      strategyId,
      siteId,
      continuationToken,
      newPassword,
      ip
    }: {
      strategyId: string
      siteId: string
      continuationToken: string
      newPassword: string
      ip?: string
    },
    req: any
  ): Promise<AfterLoginResult> {
    if (!newPassword || newPassword.length < 8) {
      throw new Error('ERR_PASSWORD_TOO_SHORT')
    }
    const { user, strategyId: expectedStrategyId } =
      await CARDINAL.models.userCredentials.validateToken({
        kind: 'changePwd',
        token: continuationToken
      })

    if (strategyId !== expectedStrategyId) {
      throw new Error('ERR_INVALID_STRATEGY')
    }

    if (user) {
      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
      await CARDINAL.models.userCredentials.patchStrategyAuth(
        user.id,
        strategyId,
        () => ({ password: passwordHash, mustChangePwd: false }),
        { mirrorInto: user }
      )

      return this.afterLoginChecks(
        user,
        strategyId,
        { ip, siteId },
        { skipChangePwd: true, skipTFA: true },
        req
      )
    } else {
      throw new Error('ERR_INVALID_USER')
    }
  }

  /**
   * Never throws and never reports which of its checks failed -- every refusal below is silently a
   * no-op. `api/auth/site.ts` answers the same generic success either way, which is what actually
   * closes the email-enumeration hole; this method just leaves nothing here for it to leak by
   * accident.
   *
   * The deactivated/restricted checks are also what stops a reset token from ever being minted for
   * such an account: `afterLoginChecks()` (via `resetPassword()`) would refuse the login anyway, but
   * only after the password hash has already been rewritten.
   */
  async forgotPassword({
    strategyId,
    email,
    siteId,
    ip
  }: {
    strategyId: string
    email: string
    siteId?: string
    ip?: string
  }): Promise<void> {
    const strategy = await CARDINAL.models.authentication.getStrategyById(strategyId)
    if (!strategy?.isEnabled || strategy.config?.allowForgotPassword !== true) {
      CARDINAL.models.flags.authDebug(
        `Forgot-password request against strategy ${strategyId}, which does not allow resets`
      )
      return
    }

    const user = await CARDINAL.models.users.getByEmail(email.toLowerCase().trim())
    const auth = (user?.auth ?? {}) as Record<string, any>
    if (!user || !auth[strategyId]?.password || !user.isActive || auth[strategyId].restrictLogin) {
      CARDINAL.models.flags.authDebug(
        `Forgot-password request for an address with no matching, resettable local account under strategy ${strategyId}`
      )
      return
    }

    const token = await CARDINAL.models.userCredentials.generateToken({
      kind: 'resetPwd',
      userId: user.id,
      meta: { strategyId }
    })
    await CARDINAL.models.auditLog.record({
      event: 'user.passwordResetRequested',
      actor: { id: user.id, name: user.name, email: user.email, ip },
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      detail: { strategyId },
      siteId: siteId ?? null
    })
    await CARDINAL.models.mail.sendForgotPassword({
      to: user.email,
      name: user.name,
      token,
      userId: user.id,
      locale: (user.prefs as Record<string, any> | undefined)?.locale,
      siteId
    })
    CARDINAL.models.flags.authDebug(`Password reset link sent to user ${user.id} <${user.email}>`)
  }

  /**
   * Finish a password reset from the `forgotPassword()` email link.
   *
   * Signs the user straight in on success, like every other token-continuation flow in this file:
   * possessing a working reset token already proves control of the account's email address.
   *
   * Deliberately NOT `skipTFA`, though: unlike `loginChangePassword()`'s continuation token (only
   * reachable after a login attempt already cleared 2FA), a reset token is minted straight from an
   * email address, so skipping would let anyone with the mailbox alone sign all the way in on an
   * account that has 2FA active.
   *
   * @throws `ERR_PASSWORD_TOO_SHORT`, `ERR_INVALID_STRATEGY`, `ERR_INVALID_USER`, plus whatever
   *         `validateToken()` raises for a token that is unknown or expired
   */
  async resetPassword(
    {
      strategyId,
      siteId,
      token,
      newPassword,
      ip
    }: {
      strategyId: string
      siteId: string
      token: string
      newPassword: string
      ip?: string
    },
    req: any
  ): Promise<AfterLoginResult> {
    if (!newPassword || newPassword.length < 8) {
      throw new Error('ERR_PASSWORD_TOO_SHORT')
    }
    const { user, strategyId: expectedStrategyId } =
      await CARDINAL.models.userCredentials.validateToken({
        kind: 'resetPwd',
        token
      })

    if (strategyId !== expectedStrategyId) {
      throw new Error('ERR_INVALID_STRATEGY')
    }
    if (!user || !user.auth?.[strategyId]) {
      throw new Error('ERR_INVALID_USER')
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    await CARDINAL.models.userCredentials.patchStrategyAuth(
      user.id,
      strategyId,
      () => ({ password: passwordHash, mustChangePwd: false }),
      { mirrorInto: user }
    )
    await CARDINAL.models.auditLog.record({
      event: 'user.passwordResetCompleted',
      actor: { id: user.id, name: user.name, email: user.email, ip },
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      detail: { strategyId },
      siteId
    })

    try {
      await CARDINAL.models.mail.sendPasswordResetConfirmed({
        to: user.email,
        name: user.name,
        userId: user.id,
        locale: user.prefs?.locale,
        siteId
      })
    } catch (err: any) {
      // -> The password change already succeeded; a failed notice email must not turn this into a
      //    failed reset.
      CARDINAL.logger.warn('auth', 'sending the password-reset-confirmed notice failed', {
        user: user.id,
        error: err
      })
    }

    return this.afterLoginChecks(user, strategyId, { ip, siteId }, { skipChangePwd: true }, req)
  }
}

export const login = new Login()
