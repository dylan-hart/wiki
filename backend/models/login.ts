import bcrypt from 'bcryptjs'
import { eq, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { users as usersTable } from '../db/schema.ts'
import { BCRYPT_ROUNDS } from '../helpers/common.ts'
import { syncRevocableGroupIds } from '../helpers/groupSync.ts'
import { AccountRateLimitedError, consumeAccountAuthAttempt } from '../helpers/rateLimit.ts'
import { isRecoveryCodeShape } from '../helpers/recoveryCodes.ts'
import { ProvisionableLoginError } from './authentication.ts'
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
   * Present only when this login just activated 2FA (a required `setupTfa` completed with a correct
   * code): the fresh recovery codes in plaintext, for the client to show and let the user save. Never
   * present, and never reconstructable, afterwards — only hashes are kept.
   */
  recoveryCodes?: string[]
  redirect: string
}

/**
 * What `register()` returns: an `AfterLoginResult` when `emailValidation` is off and registration
 * signs the user straight in, or a bare `{ nextAction: 'verify' }` when a confirmation email was sent
 * instead and nothing about the session has changed. `redirect` is the one field `AfterLoginResult`
 * always carries that a pending verification has none of, so it is optional here rather than repeating
 * the whole shape as a union.
 */
export interface RegisterResult {
  authenticated?: boolean
  nextAction: string
  continuationToken?: string
  tfaQRImage?: string
  redirect?: string
}

/**
 * Login model
 *
 * The flows that turn a credential into a session: password and provider login, registration, the
 * 2FA and forced-password-change continuations a login can be suspended into, and the forgotten /
 * reset password round trip.
 *
 * Split out of `models/users.ts` (MOD-F12): an account (`models/users.ts`) and the credentials on it
 * (`models/userCredentials.ts`) are both things that exist between requests, while everything here is
 * one request's journey through them.
 */
class Login {
  async login(
    { siteId, strategyId, username, password, ip }: LoginOptions,
    req: any
  ): Promise<AfterLoginResult> {
    if (strategyId in WIKI.auth.strategies) {
      const str = WIKI.auth.strategies[strategyId] as any
      const strInfo = WIKI.data.authentication.find((a: any) => a.key === str.module)

      // -> Defense in depth, not the only guard: the route schema already requires `password` on
      //    the request body, but a form-based module's own verification bind must not depend on
      //    that alone — refuse an empty/missing password here too, before `str.authenticate()` ever
      //    runs, rather than trusting every present and future `useForm` module to check it itself.
      if (strInfo.useForm && !password) {
        WIKI.models.flags.authDebug(
          `Login attempt on site ${siteId} using ${str.module} strategy ${strategyId} rejected: no password provided`
        )
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
      WIKI.models.flags.authDebug(
        `Login attempt on site ${siteId} using ${str.module} strategy ${strategyId}${username ? ` as "${username}"` : ''} from ${ip}`
      )

      /*
        Account-keyed bound, independent of `req.ip` (which `helpers/rateLimit.ts#limitAuthAttempts`
        already bounds via the `onRequest` hook on this route, but which a misconfigured
        `security.trustProxy` can leave client-spoofable per request) -- see
        `consumeAccountAuthAttempt`'s own doc comment. Only form-based strategies have a credential to
        guess here; a redirect-based provider (OAuth/SAML) never reaches this branch with a `username`.
        Checked before `str.authenticate()` so a tripped limit also saves the bcrypt/LDAP round trip.
      */
      if (strInfo.useForm && username) {
        const verdict = await consumeAccountAuthAttempt(username)
        if (!verdict.allowed) {
          WIKI.models.flags.authDebug(
            `Rate limit: refused login for account "${username}", ${verdict.retryAfter}s left of its ban.`
          )
          throw new AccountRateLimitedError(verdict.retryAfter)
        }
      }

      // Authenticate
      let user
      try {
        user = await str.authenticate(context)
      } catch (err: any) {
        /*
          A form-based module (LDAP) verifies the person itself and never resolves a local user — it
          always throws this once verification succeeds, whether or not an account already exists, so
          every login (not only the one that creates an account) goes through the same find-or-create
          path a redirect-based provider uses, which is also what re-syncs group membership on every
          login. `findOrCreateProviderUser()` enforces `autoProvision` itself, and only for the case
          that actually needs it: an unknown address with no local account. Gating on it *here* as well
          would refuse a returning user who already has an account the moment `autoProvision` is turned
          off — the flag means "accepts new users", not "accepts logins" — so it is deliberately not
          checked again at this outer layer.
        */
        if (strInfo.useForm && err instanceof ProvisionableLoginError) {
          const providerStrategy = await WIKI.models.authentication.getStrategyById(strategyId)
          if (!providerStrategy) {
            throw new Error('ERR_INVALID_STRATEGY')
          }
          user = await this.findOrCreateProviderUser(providerStrategy, err.profile)
        } else {
          WIKI.models.flags.authDebug(
            `Strategy ${str.module} rejected the attempt${username ? ` for "${username}"` : ''}: ${err.message}`
          )
          // -> Never the password, same as the debug line above. No user id either -- an attempt
          //    that failed authentication is not attributable to an account, only to whatever the
          //    caller claimed to be.
          await WIKI.models.auditLog.record({
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

      // Perform post-login checks
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
      WIKI.models.flags.authDebug(`Login attempt using unknown strategy ${strategyId} from ${ip}`)
      throw new Error('Invalid Strategy ID')
    }
  }

  /**
   * Log somebody in from what an identity provider said about them, creating the account if the
   * strategy is set to accept new users.
   *
   * An existing account is bound to the provider's own `id`, checked on every later login — the
   * address alone is never enough, because a provider that can be made to assert an arbitrary email is
   * otherwise a way to sign in as whichever account already used it. See `findOrCreateProviderUser()`.
   *
   * Auto-provisioning is refused rather than silently allowed: a wiki that has not opened its doors to
   * a provider gets `ERR_REGISTRATION_DISABLED` for an unknown account, and one that has can still
   * limit who by, with the strategy's email allow-list pattern.
   *
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
      A password change is never asked for here: `mustChangePwd` lives on the local strategy's own
      auth entry and is about a stored password this login never touches, so it stays skipped.

      2FA is deliberately NOT skipped, though (see docs/decisions/provider-login-2fa.md): a TOTP
      secret enrolled under the local strategy is a signal the account's owner wanted a second
      factor regardless of which door they used to sign in, so `afterLoginChecks()` still stops a
      provider login at `provideTfa` when one is active there -- independently of whatever MFA the
      provider itself may already have performed. An account with no locally-enrolled secret sees
      no change: this call still sails through unless the provider strategy's own `auth` entry (in
      practice, almost never populated) has one active.
    */
    return this.afterLoginChecks(user, strategy.id, { ip, siteId }, { skipChangePwd: true }, req)
  }

  /**
   * Find the account an identity provider's profile belongs to, creating and linking one if the
   * strategy accepts new users — and syncing group membership either way.
   *
   * The account-creation half of what used to be `loginWithProvider()` alone, factored out because
   * `login()`'s auto-provisioning branch (a form-based module like LDAP, whose `authenticate()` found
   * no local match and threw `ProvisionableLoginError`) needs exactly the same find-or-create rules
   * rather than a second copy of them.
   *
   * Identity, once an account exists, is `profile.id` matched against the `auth[strategy.id].id` a
   * previous login stored — never the email address alone, and never a strategy other than this exact
   * one: a module must not be able to walk in and claim an account linked under a different strategy.
   * An address matching an account with no stored link for this strategy is refused with
   * `ERR_ACCOUNT_NOT_LINKED` unless the strategy has `trustEmailForLinking` on, an explicit
   * administrator opt-in for a provider whose email is verified. A system account (the seeded Guest
   * row, currently the only one) never signs in through any provider, matched or not.
   *
   * `isActive`/`isVerified` are deliberately not checked here: both callers hand the returned user
   * straight to `afterLoginChecks()`, which is the one place that check belongs now.
   *
   * Separated name halves (Feature #2608) reach the account from here and nowhere else in the
   * provider path. On creation the halves are handed to `createUser()` INSTEAD of a display name, so
   * `resolveNameFields()` derives `name` from them and the row is not born locally edited; a profile
   * carrying neither half falls back to the single display name as before. On every later login a
   * half the account is still missing is filled in, and a half it already has is left alone — a
   * provider is a source for a field nobody has answered yet, not an authority that overwrites what
   * a person wrote. Note that "is this authored" is not asked here: `updateUser()` consults the row's
   * own `nameLocallyEdited` marker to decide whether `name` re-derives, and this method never sets
   * it. `firstName`/`lastName` are `''` on a row nothing has filled, never null, so the emptiness
   * test needs no defaulting.
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
    let user = await WIKI.models.users.getByEmail(email)

    // -> Checked before anything else: a system account (the seeded Guest row) must never be reachable
    //    through a provider, linked or not -- getByEmail() has no isSystem filter, unlike its siblings.
    if (user?.isSystem) {
      WIKI.models.flags.authDebug(
        `Provider login for <${email}> refused: address belongs to a system account`
      )
      throw new Error('ERR_LOGIN_FAILED')
    }

    // -> Set only when this specific call is the moment a previously-unlinked account gets linked
    //    to `strategy` via `trustEmailForLinking` -- the "successfully relinks via SSO" event
    //    `clearMigratedFallbackLocalAuth()` below exists for. Never true for an account that was
    //    already linked, a brand-new account, or a plain re-write of an existing link.
    let justRelinkedViaTrustedEmail = false

    if (user) {
      const auth = (user.auth ?? {}) as Record<string, any>
      const linkedId = auth[strategy.id]?.id
      if (linkedId === undefined) {
        if (!strategy.trustEmailForLinking) {
          WIKI.models.flags.authDebug(
            `Provider login for <${email}> refused: no stored account link for strategy ${strategy.id}, and trustEmailForLinking is off`
          )
          throw new Error('ERR_ACCOUNT_NOT_LINKED')
        }
        justRelinkedViaTrustedEmail = true
      } else if (linkedId !== profile.id) {
        WIKI.models.flags.authDebug(
          `Provider login for <${email}> refused: profile id does not match the account link stored for strategy ${strategy.id}`
        )
        throw new Error('ERR_ACCOUNT_NOT_LINKED')
      }
      // -> Applied on every login, not only account creation: turning the pattern down after an
      //    account was linked under a looser one must not leave that account grandfathered in.
      this.assertAllowedProviderEmail(strategy, email)
    } else {
      if (!strategy.autoProvision) {
        WIKI.models.flags.authDebug(
          `Provider login for unknown address <${email}> refused: strategy ${strategy.id} does not accept new users`
        )
        throw new Error('ERR_REGISTRATION_DISABLED')
      }
      this.assertAllowedProviderEmail(strategy, email)
      const userId = await WIKI.models.users.createUser({
        // -> The halves win when the provider issued either: passing them alongside `name` would
        //    mark the row locally edited the moment the provider's display name is not exactly
        //    `first last` ("Dr. Alice Example"), permanently freezing the derivation.
        ...(firstName || lastName ? { firstName, lastName } : { name: profile.name || email }),
        email,
        // -> Nothing signs in with it: this account authenticates at the provider, and the local
        //    strategy's own entry is what a password would live under
        password: nanoid(32),
        groups: strategy.autoEnrollGroups ?? [],
        isVerified: true
      })
      user = await WIKI.models.users.getById(userId)
      WIKI.models.flags.authDebug(
        `Created user ${userId} <${email}> from ${strategy.module} strategy ${strategy.id}`
      )
    }

    if (!user) {
      throw new Error('ERR_LOGIN_FAILED')
    }

    /*
      The link between this account and the provider's, written on every login: it records which
      account at the provider this is, and it is what tells the profile page that this user signs in
      through this strategy.
    */
    await WIKI.models.userCredentials.patchStrategyAuth(
      user.id,
      strategy.id,
      () => ({ id: profile.id, email }),
      {
        mirrorInto: user
      }
    )

    // -> Only right after the relink above actually took hold, never on an ordinary login.
    if (justRelinkedViaTrustedEmail) {
      await this.clearMigratedFallbackLocalAuth(user)
    }

    await this.fillMissingNameHalves(user, firstName, lastName)

    // -> Every login, not only the one that created the account: a group added or removed at the
    //    provider since the last login has to show up here too.
    if (strategy.config?.mapGroups && profile.groups) {
      await this.syncProviderGroups(user, strategy, profile.groups)
    }

    return user
  }

  /**
   * Fill in a name half the account does not have yet, from what the provider just reported.
   *
   * Only an EMPTY field is written. A populated one is left exactly as it is, whoever put it there —
   * the user, an administrator, or an earlier login through this same provider — which is what makes
   * a locally corrected name survive every subsequent sign-in. A provider that reported neither half
   * costs nothing: no row is read and no statement is issued.
   *
   * `nameLocallyEdited` is deliberately absent from the patch. `updateUser()` owns the display-name
   * rule (Task #2639) and re-derives `name` from the resulting pair unless the row is already marked
   * authored; setting the marker from here would be a second owner of that decision, and clearing it
   * would let a provider quietly undo somebody's edit.
   *
   * The row is re-read and merged back onto `user` afterwards rather than the patch being assigned
   * onto it: `updateUser()` also re-derives `name`, so the caller — which returns this same object,
   * and whose `afterLoginChecks()` reads `name` onto the session — would otherwise carry the display
   * name from before the fill for the rest of the request. That extra read only happens on a login
   * that actually filled something in, which is at most once per account per half.
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
    await WIKI.models.users.updateUser(user.id, patch)
    const refreshed = await WIKI.models.users.getById(user.id)
    if (refreshed) {
      Object.assign(user, refreshed)
    }
  }

  /**
   * Once a migrated fallback account relinks to its real identity provider (the
   * `trustEmailForLinking` branch in `findOrCreateProviderUser()` above), the orphaned
   * local-strategy auth entry `createProviderFallbackUserConverter()` originally wrote for it (a
   * random, unknowable password plus `mustChangePwd: true`) has nothing left to protect and
   * nothing left to prompt for -- the account signs in through the provider now. Left alone it
   * keeps showing up everywhere `mustChangePwd` is read as "needs a password reset" (the forced
   * change-password screen on the rare local login attempt, any admin-facing "needs attention"
   * list, ...).
   *
   * Gated on `auth[localStrategyId].migratedFallbackProvider` -- the marker
   * `createProviderFallbackUserConverter()` writes on every account it creates (Feature #2547's
   * sibling Task) -- rather than on `mustChangePwd` alone: an admin-forced password reset on a
   * genuine local account is also stored as `mustChangePwd: true`, and that same account could
   * separately link a `trustEmailForLinking` strategy of its own one day. Clearing on
   * `mustChangePwd` alone would let a login through SSO silently cancel a reset an administrator
   * deliberately imposed. Without the marker present -- an account created before that field
   * existed, or the sibling Task not yet landed in a given build -- this is correctly a no-op:
   * there is no other way to tell the two cases apart, so refusing to guess is the safe default.
   *
   * Clears the marker at the same time as `mustChangePwd`, so the account also stops looking like
   * a pending fallback to anything reading the marker for its own purposes (the report surface
   * planned as this Feature's third Task).
   */
  private async clearMigratedFallbackLocalAuth(user: { id: string; auth: unknown }): Promise<void> {
    const localStrategyId = WIKI.data.systemIds.localAuthId
    const localAuth = ((user.auth ?? {}) as Record<string, any>)[localStrategyId]
    if (!localAuth?.migratedFallbackProvider) {
      return
    }

    await WIKI.models.userCredentials.patchStrategyAuth(
      user.id,
      localStrategyId,
      () => ({ mustChangePwd: false, migratedFallbackProvider: undefined }),
      { mirrorInto: user }
    )

    WIKI.models.flags.authDebug(
      `Cleared the stale migrated-fallback local auth entry for user ${user.id} after it relinked via a trusted-email provider`
    )
  }

  /** @throws `ERR_EMAIL_NOT_ALLOWED` when the strategy has a pattern and the address does not match it. */
  private assertAllowedProviderEmail(strategy: AuthStrategy, email: string): void {
    if (!strategy.allowedEmailRegex) {
      return
    }
    let allowed = false
    try {
      allowed = new RegExp(strategy.allowedEmailRegex).test(email)
    } catch (err: any) {
      // -> A pattern that will not compile allows nobody, rather than everybody
      WIKI.logger.warn(
        `Strategy ${strategy.id} has an invalid email pattern, refusing: ${err.message}`
      )
    }
    if (!allowed) {
      throw new Error('ERR_EMAIL_NOT_ALLOWED')
    }
  }

  /**
   * Local self-registration's own domain allow-list, distinct from `allowedEmailRegex` above --
   * `allowedEmailRegex` also gates provider auto-provisioning, but this is scoped to
   * `register()` alone (WP #2470 / Feature #2430). Empty means unrestricted. Matching is
   * case-insensitive against the domain after the address's last `@`; `strategy.allowedEmailDomains`
   * is already lowercased and trimmed at write time (`models/authentication.ts#normalizeEmailDomains`),
   * so only the incoming email needs folding here.
   *
   * @throws `ERR_EMAIL_NOT_ALLOWED` when the strategy has a non-empty list and the address's domain
   *         is not on it.
   */
  private assertAllowedRegistrationDomain(strategy: AuthStrategy, email: string): void {
    if (!strategy.allowedEmailDomains || strategy.allowedEmailDomains.length < 1) {
      return
    }
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
    if (!strategy.allowedEmailDomains.includes(domain)) {
      WIKI.models.flags.authDebug(
        `Registration refused: domain <${domain}> is not on strategy ${strategy.id}'s allowed list`
      )
      throw new Error('ERR_EMAIL_NOT_ALLOWED')
    }
  }

  /**
   * Reconcile a user's wiki group membership with the groups an identity provider just reported for
   * them, adding what is newly granted and removing what is no longer reported — mirroring 2.5.x's
   * `passport-ldapauth` / `passport-saml` modules' add/remove-by-difference behavior.
   *
   * Several memberships are never touched by this, regardless of what was reported:
   *
   *   - the guests group, which is anonymous access itself rather than something a provider can grant
   *     or take away from a real account;
   *   - any group still named in the strategy's own `autoEnrollGroups` — an administrator put that
   *     grant there directly, and a provider that has simply stopped mentioning the group should not
   *     silently undo it;
   *   - every group carrying `manage:system` (`groups.systemGroupIds()`) and the configured root
   *     administrators group (`WIKI.config.auth.rootAdminGroupId`) — an IdP can never grant or revoke
   *     wiki-level administrative access, mirroring the same invariant `api/users/admin.ts` enforces for a
   *     human editing group membership directly. This holds unconditionally, independent of the
   *     allow-list below;
   *   - any group outside the strategy's own `mappableGroups` allow-list — an admin-chosen subset of
   *     what this strategy may grant/revoke at all. The default is empty, so a strategy that has not
   *     been configured with an allow-list changes no memberships on login.
   *
   * Group names are matched case-insensitively and trimmed, since that is how directory group names are
   * routinely typed inconsistently.
   *
   * @param user The account to sync, at minimum `{ id }`
   * @param reportedGroups Group names as the provider reported them for this login
   */
  async syncProviderGroups(
    user: { id: string },
    strategy: AuthStrategy,
    reportedGroups: string[]
  ): Promise<void> {
    const guestsGroupId = WIKI.data.systemIds.guestsGroupId
    const rootAdminGroupId = WIKI.config.auth.rootAdminGroupId
    const systemGroupIds = await WIKI.models.groups.systemGroupIds()
    const neverMapped = new Set([guestsGroupId, rootAdminGroupId, ...systemGroupIds])
    const mappable = new Set(strategy.mappableGroups ?? [])
    // -> Which of the currently-held allow-listed groups this login is allowed to take away --
    //    shared with `models/authentication.ts#getGroupSyncWarnings()`, the admin-facing read that
    //    warns before the same exclusion bites a manual grant (WP #2440).
    const revocable = new Set(
      syncRevocableGroupIds(strategy, { guestsGroupId, rootAdminGroupId, systemGroupIds })
    )

    const reportedNames = new Set(
      reportedGroups.map((name) => name.trim().toLowerCase()).filter(Boolean)
    )
    const allGroups = await WIKI.models.groups.getAllGroups()
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

    const currentGroupIds = await WIKI.models.users.getUserGroupIds(user.id)
    const currentSet = new Set(currentGroupIds)

    const toAdd = [...matchedGroupIds].filter((id) => !currentSet.has(id))
    // -> Only a currently-revocable group can ever be removed: `revocable` already excludes
    //    everything `mappable.has(id)` would let through that must not actually be taken away
    //    (guests, system/root-admin groups, anything the strategy also `autoEnrollGroups`).
    const toRemove = currentGroupIds.filter((id) => revocable.has(id) && !matchedGroupIds.has(id))

    if (toAdd.length < 1 && toRemove.length < 1) {
      return
    }

    for (const groupId of toAdd) {
      await WIKI.models.groups.assignUserToGroup(groupId, user.id)
    }
    for (const groupId of toRemove) {
      await WIKI.models.groups.unassignUserFromGroup(groupId, user.id)
    }

    WIKI.models.flags.authDebug(
      `Synced provider groups for user ${user.id} via strategy ${strategy.id}: +${toAdd.length} / -${toRemove.length}`
    )
  }

  /**
   * Self-registration through a form-based strategy, mirroring `loginWithProvider()`'s checks for
   * whether the strategy accepts new users and who by.
   *
   * When the strategy's `emailValidation` config is on (the local strategy's default), the account is
   * created unverified and a `verify`-kind token is emailed instead of logging the user in --
   * `GET /auth/verify/:token` is what turns `isVerified` on. With `emailValidation` off, this ends in
   * exactly the `afterLoginChecks()` call `loginWithProvider()` makes, so registration signs the user
   * straight in like every other successful auth path.
   *
   * An address stuck unverified -- its verification email lost, or never arrived -- is not a dead
   * end: registering again with the same address resends the link rather than refusing with
   * `ERR_EMAIL_ALREADY_EXISTS`, since nobody else could have claimed that address in the meantime (an
   * unverified account cannot log in). The submitted `name` and `password` are ignored on that path --
   * only the address that already exists is trusted -- so registering an address that is not yours but
   * still pending cannot be used to overwrite whatever password it was originally set up with.
   *
   * A strategy with `emailValidation` on never throws `ERR_EMAIL_ALREADY_EXISTS`, even for an address
   * that already has a *verified* account: it answers the same generic `{ nextAction: 'verify' }` a
   * genuinely new registration would, and emails the real owner a notice that someone tried to
   * register with their address, instead. This mirrors `forgotPassword()`'s own address-enumeration
   * design (same file) -- without it, a single unauthenticated registration attempt would confirm
   * whether a given email address already has an account here, no measurement required. A strategy
   * with `emailValidation` off has no email step to route this secrecy through -- registration there
   * signs the caller straight in, so there is nothing to send "the real owner" instead of just
   * refusing -- and keeps throwing `ERR_EMAIL_ALREADY_EXISTS` for a colliding address.
   *
   * A strategy is only ever eligible here when its module is form-based (`useForm: true`) and it is
   * attached to the site the request came in on -- `createUser()` always writes the submitted password
   * under the local strategy, so accepting this against a redirect-based provider (SAML, OIDC, LDAP's
   * own delegation, ...) would mint a permanent local account for an identity that provider was
   * supposed to own, bypassing it entirely.
   *
   * @throws `ERR_INVALID_STRATEGY`, `ERR_REGISTRATION_DISABLED`, `ERR_EMAIL_ALREADY_EXISTS`,
   *         `ERR_EMAIL_NOT_ALLOWED`
   */
  async register(
    {
      siteId,
      strategyId,
      name,
      email,
      password,
      ip
    }: {
      siteId: string
      strategyId: string
      name: string
      email: string
      password: string
      ip?: string
    },
    req: any
  ): Promise<RegisterResult> {
    const strategy = await WIKI.models.authentication.getStrategyById(strategyId)
    if (!strategy || !strategy.isEnabled) {
      WIKI.models.flags.authDebug(`Registration attempt against unknown strategy ${strategyId}`)
      throw new Error('ERR_INVALID_STRATEGY')
    }

    // -> Resolved the way `login()` resolves it: only a form-based module verifies the credentials it
    //    is handed, so only one may mint a local account through this public form.
    const authModule = WIKI.data.authentication.find((a: any) => a.key === strategy.module)
    if (!authModule?.useForm) {
      WIKI.models.flags.authDebug(
        `Registration refused: strategy ${strategy.id} (${strategy.module}) is not a form-based module`
      )
      throw new Error('ERR_INVALID_STRATEGY')
    }

    // -> A strategy exists globally the moment it is configured, but only accepts requests through
    //    the sites an administrator attached it to.
    const site = await WIKI.models.sites.getSiteById({ id: siteId })
    const attachedToSite = (site?.config?.authStrategies ?? []).some(
      (s: any) => s.id === strategyId
    )
    if (!attachedToSite) {
      WIKI.models.flags.authDebug(
        `Registration refused: strategy ${strategy.id} is not attached to site ${siteId}`
      )
      throw new Error('ERR_INVALID_STRATEGY')
    }

    if (!strategy.selfRegistration) {
      WIKI.models.flags.authDebug(
        `Registration refused: strategy ${strategy.id} does not accept new users`
      )
      throw new Error('ERR_REGISTRATION_DISABLED')
    }

    const normalizedEmail = email.toLowerCase().trim()

    // -> Fail fast, before the existing-account lookup below: a domain refusal is a blanket rule
    //    about the domain, not about this specific address, so checking it first reveals nothing
    //    about whether that address already has an account here.
    this.assertAllowedRegistrationDomain(strategy, normalizedEmail)

    const requiresVerification = Boolean(strategy.config?.emailValidation)
    const existing = await WIKI.models.users.getByEmail(normalizedEmail)

    if (existing) {
      if (!requiresVerification) {
        // -> No email step to route secrecy through on this strategy -- registration here signs the
        //    caller straight in, so there is nothing to send the real owner instead of just refusing.
        throw new Error('ERR_EMAIL_ALREADY_EXISTS')
      }
      if (!existing.isVerified) {
        WIKI.models.flags.authDebug(
          `Registration for <${normalizedEmail}> matched an unverified account, resending the verification email`
        )
        const token = await WIKI.models.userCredentials.generateToken({
          kind: 'verify',
          userId: existing.id
        })
        await WIKI.models.mail.sendVerifyEmail({ to: existing.email, name: existing.name, token })
        return { nextAction: 'verify' }
      }
      // -> A verified account already sits at this address. Answering the same generic
      //    { nextAction: 'verify' } a fresh registration gets -- rather than ERR_EMAIL_ALREADY_EXISTS
      //    -- is what keeps this response from confirming the address is taken; the real owner gets a
      //    notice instead, mirroring forgotPassword()'s design just above.
      WIKI.models.flags.authDebug(
        `Registration for <${normalizedEmail}> matched an existing verified account; notifying instead of confirming`
      )
      try {
        await WIKI.models.mail.sendRegistrationAttemptNotice({
          to: existing.email,
          name: existing.name,
          locale: (existing.prefs as Record<string, any> | undefined)?.locale
        })
      } catch (err: any) {
        WIKI.logger.warn(
          `Failed to send the registration-attempt notice to ${existing.email}: ${err.message}`
        )
      }
      return { nextAction: 'verify' }
    }

    this.assertAllowedProviderEmail(strategy, normalizedEmail)

    const userId = await WIKI.models.users.createUser({
      name,
      email: normalizedEmail,
      password,
      groups: strategy.autoEnrollGroups ?? [],
      isVerified: !requiresVerification
    })
    WIKI.models.flags.authDebug(
      `Registered user ${userId} <${normalizedEmail}> via ${strategy.module} strategy ${strategy.id}, verification ${requiresVerification ? 'required' : 'not required'}`
    )

    if (requiresVerification) {
      const token = await WIKI.models.userCredentials.generateToken({ kind: 'verify', userId })
      await WIKI.models.mail.sendVerifyEmail({ to: normalizedEmail, name, token })
      return { nextAction: 'verify' }
    }

    const user = await WIKI.models.users.getById(userId)
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
    const str = WIKI.auth.strategies[strategyId] as any
    if (!str) {
      throw new Error('ERR_INVALID_STRATEGY')
    }

    // -> The funnel every login path ends in: local, provider, passkey and the 2FA/password-change/
    //    reset-password continuations all call this method, so this is the one place an account-state
    //    check is guaranteed to run regardless of which path got here. `restrictLogin` is deliberately
    //    NOT checked here -- it is a per-strategy (local-only) flag, already enforced by
    //    `modules/authentication/local/authentication.ts#authenticate()` before a local login ever
    //    reaches this method, and by `forgotPassword()` before a reset token is minted.
    if (!user.isActive) {
      throw new Error('ERR_INACTIVE_USER')
    }
    if (!user.isVerified) {
      throw new Error('ERR_USER_NOT_VERIFIED')
    }

    // Get user groups
    user.groups = await WIKI.db.query.users
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

    // Get redirect target
    let redirect = '/'
    if (user.groups && user.groups.length > 0) {
      for (const grp of user.groups as any[]) {
        if (grp.redirectOnLogin && grp.redirectOnLogin !== '/') {
          redirect = grp.redirectOnLogin
          break
        }
      }
    }

    // Get auth strategy flags
    const authStr = user.auth[strategyId] || {}

    // Is 2FA required?
    if (!skipTFA) {
      /*
        A TOTP secret enrolled under the local strategy gates every login for the account, not
        just one made through the local strategy itself -- enrolling it is a deliberate choice by
        the account's owner, made independently of which door they use to sign in next. Without
        this fallback, a provider login (whose own `auth[strategyId]` entry almost never has a
        secret of its own) would sail straight past a second factor the owner explicitly turned
        on. See docs/decisions/provider-login-2fa.md.
      */
      const localStrategyId = WIKI.data.systemIds.localAuthId
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
          const tfaToken = await WIKI.models.userCredentials.generateToken({
            kind: 'tfa',
            userId: user.id,
            meta: {
              strategyId,
              tfaStrategyId
            }
          })
          WIKI.models.flags.authDebug(
            `User ${user.id} <${user.email}> authenticated, but a 2FA code is required first`
          )
          return {
            nextAction: 'provideTfa',
            continuationToken: tfaToken,
            redirect
          }
        } catch (errc) {
          WIKI.logger.warn(errc)
          throw new Error('ERR_TFA_FAILED')
        }
      } else if (str.config?.enforceTfa || authStr.tfaRequired) {
        try {
          const { tfaQRImage } = await WIKI.models.userCredentials.startTfaSetup(
            user,
            strategyId,
            context.siteId
          )
          const tfaToken = await WIKI.models.userCredentials.generateToken({
            kind: 'tfaSetup',
            userId: user.id,
            meta: {
              strategyId
            }
          })
          WIKI.models.flags.authDebug(
            `User ${user.id} <${user.email}> authenticated, but must set up 2FA first`
          )
          return {
            nextAction: 'setupTfa',
            continuationToken: tfaToken,
            tfaQRImage,
            redirect
          }
        } catch (errc) {
          WIKI.logger.warn(errc)
          throw new Error('ERR_TFA_FAILED')
        }
      }
    }

    // Must Change Password?
    if (!skipChangePwd && authStr.mustChangePwd) {
      try {
        const pwdChangeToken = await WIKI.models.userCredentials.generateToken({
          kind: 'changePwd',
          userId: user.id,
          meta: {
            strategyId
          }
        })

        WIKI.models.flags.authDebug(
          `User ${user.id} <${user.email}> authenticated, but must change their password first`
        )
        return {
          nextAction: 'changePassword',
          continuationToken: pwdChangeToken,
          redirect
        }
      } catch (errc) {
        WIKI.logger.warn(errc)
        throw new Error('ERR_CHANGE_PASSWORD_FAILED')
      }
    }

    // Set Session Data
    await WIKI.models.users.updateSession(user, req)

    WIKI.models.flags.authDebug(
      `User ${user.id} <${user.email}> logged in with ${user.groups.length} group(s) and ${req?.session?.permissions?.length ?? 0} permission(s), redirecting to ${redirect}`
    )

    // -> Only once the login has actually succeeded: an attempt stopped by 2FA or a forced password
    //    change is not a login yet.
    //    Every login path -- local, provider, passkey, and the 2FA / password-change continuations --
    //    ends up here, so this is the one place the stamp belongs. `updatedAt` is deliberately left
    //    alone: signing in is not an edit of the account.
    await WIKI.db
      .update(usersTable)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(usersTable.id, user.id))

    // -> Same reasoning as `user:join` above: a login has no site context, so a site-scoped hook must
    //    not receive it.
    await WIKI.models.hooks.emit('user:login', null, {
      userId: user.id,
      strategyId,
      ip: context.ip,
      metadata: {
        name: user.name,
        email: user.email
      }
    })

    await WIKI.models.auditLog.record({
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
   * The continuation token identifies the half-finished login, and is kept rather than consumed while
   * codes are being tried: a mistyped or just-expired code has to be retryable. It is destroyed here
   * as soon as one is correct, and by `countTfaFailure()` once too many have not been.
   *
   * @param setup True when the token came from a required setup, in which case a correct code also
   *              activates the secret that was generated for it. A recovery code cannot complete a
   *              setup — none exist yet for a secret that has never been activated — so `securityCode`
   *              must be the 6-digit TOTP code here.
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
    // -> Recovery codes only exist once 2FA is active, so they cannot answer a `setupTfa` login —
    //    that flow only ever proves a freshly-generated TOTP secret works.
    const isRecoveryShape = !setup && isRecoveryCodeShape(securityCode)
    if (!continuationToken || (!isTotpShape && !isRecoveryShape)) {
      throw new Error('ERR_TFA_INVALID_REQUEST')
    }

    const {
      user,
      strategyId: expectedStrategyId,
      tfaStrategyId
    } = await WIKI.models.userCredentials.validateToken({
      kind: setup ? 'tfaSetup' : 'tfa',
      token: continuationToken,
      skipDelete: true
    })
    if (!user) {
      throw new Error('ERR_INVALID_USER')
    }
    // -> Account-keyed bound on the second factor itself: a continuation token proves the password
    //    was already right, so what is left to guess is the TOTP code or a recovery code, and
    //    either is guessable enough on its own to be worth bounding per account (see `login()`'s
    //    own call for the reasoning shared with the password step). Same bucket as `login()`'s own
    //    call, into the same `auth:user:` key -- TOTP-code and recovery-code guessing against an
    //    account is bounded together with password guessing against it, not as a separate budget.
    //    See `consumeAccountAuthAttempt`'s doc comment.
    const verdict = await consumeAccountAuthAttempt(user.email)
    if (!verdict.allowed) {
      WIKI.models.flags.authDebug(
        `Rate limit: refused 2FA attempt for user ${user.id} <${user.email}>, ${verdict.retryAfter}s left of its ban.`
      )
      throw new AccountRateLimitedError(verdict.retryAfter)
    }
    if (strategyId !== expectedStrategyId) {
      throw new Error('ERR_INVALID_STRATEGY')
    }

    // -> The strategy whose secret actually gates this login: ordinarily the one just logged in
    //    with, but a provider login stopped by a locally-enrolled secret (see `afterLoginChecks()`)
    //    records which strategy's secret that was, since it is not this one.
    const verifyStrategyId = tfaStrategyId || strategyId

    let verified: boolean
    if (isTotpShape) {
      verified = await WIKI.models.userCredentials.verifyTfaCode(
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
        throw new Error('ERR_TFA_RECOVERY_CODES_EXHAUSTED')
      }
      verified = await WIKI.models.userCredentials.verifyAndConsumeRecoveryCode(
        user,
        verifyStrategyId,
        securityCode
      )
    }
    if (!verified) {
      await countTfaFailure(continuationToken)
      WIKI.models.flags.authDebug(`User ${user.id} <${user.email}> submitted an incorrect 2FA code`)
      throw new Error('ERR_TFA_INCORRECT_TOKEN')
    }

    await WIKI.models.userCredentials.destroyToken({ token: continuationToken })
    let recoveryCodes: string[] | undefined
    if (setup) {
      recoveryCodes = await WIKI.models.userCredentials.enableTfa(user, strategyId)
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
   * @returns The QR code to scan, the secret behind it for manual entry, and the token that
   *          `confirmTfaSetup()` expects back
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
    const { user, entry } = await WIKI.models.userCredentials.requireStrategyAuth(
      userId,
      strategyId
    )
    // -> Replacing a working secret would silently invalidate the app entry the user already has;
    //    turning 2FA off first is the way to start again
    if (entry.tfaIsActive) {
      throw new Error('ERR_TFA_ALREADY_ACTIVE')
    }

    const { secret, tfaQRImage } = await WIKI.models.userCredentials.startTfaSetup(
      user,
      strategyId,
      siteId
    )
    const continuationToken = await WIKI.models.userCredentials.generateToken({
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
   * @returns The fresh recovery codes in plaintext, for the profile page to display and let the user
   *          save — the only time they are ever available again
   * @throws `ERR_TFA_INVALID_REQUEST`, `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY` or
   *         `ERR_TFA_INCORRECT_TOKEN`
   */
  async confirmTfaSetup({
    userId,
    strategyId,
    continuationToken,
    securityCode
  }: {
    userId: string
    strategyId: string
    continuationToken: string
    securityCode: string
  }): Promise<{ recoveryCodes: string[] }> {
    if (!continuationToken || !/^[0-9]{6}$/.test(securityCode)) {
      throw new Error('ERR_TFA_INVALID_REQUEST')
    }

    const { user, strategyId: expectedStrategyId } =
      await WIKI.models.userCredentials.validateToken({
        kind: 'tfaSetup',
        token: continuationToken,
        skipDelete: true
      })
    // -> The token is a bearer credential, so it only counts for the session that asked for it
    if (!user || user.id !== userId) {
      throw new Error('ERR_INVALID_USER')
    }
    if (strategyId !== expectedStrategyId) {
      throw new Error('ERR_INVALID_STRATEGY')
    }
    if (!(await WIKI.models.userCredentials.verifyTfaCode(user, strategyId, securityCode))) {
      await countTfaFailure(continuationToken)
      throw new Error('ERR_TFA_INCORRECT_TOKEN')
    }

    await WIKI.models.userCredentials.destroyToken({ token: continuationToken })
    const recoveryCodes = await WIKI.models.userCredentials.enableTfa(user, strategyId)
    return { recoveryCodes }
  }

  /**
   * Where to send a user after logging out.
   *
   * A group's own target wins over the site's, which is what the admin area promises: the site setting
   * says it "can be overridden at the group level". With several groups the first one that names a
   * target wins, the same arbitrary-but-stable rule the login redirect uses.
   *
   * @param userId The user logging out, or null for a request that was not logged in
   * @param siteId The site being logged out of, if it is known
   * @returns A path or URL, never empty — the site root when nothing is configured
   */
  async getLogoutRedirect(userId: string | null, siteId?: string): Promise<string> {
    if (userId) {
      const groups = await WIKI.db.query.users
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

    const site = siteId ? await WIKI.models.sites.getSiteById({ id: siteId }) : null
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
      await WIKI.models.userCredentials.validateToken({
        kind: 'changePwd',
        token: continuationToken
      })

    if (strategyId !== expectedStrategyId) {
      throw new Error('ERR_INVALID_STRATEGY')
    }

    if (user) {
      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
      await WIKI.models.userCredentials.patchStrategyAuth(
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
   * Request a password reset link by email.
   *
   * Never throws and never reports which of its checks failed: an unknown/disabled strategy, one
   * with `allowForgotPassword` off, an email matching no account, an account that has no password
   * under this strategy (e.g. provider-only), a deactivated account, and one whose password login has
   * been restricted (`restrictLogin`) are all silently a no-op. `api/auth/site.ts`'s route
   * answers the same generic success either way, which is what actually closes the
   * email-enumeration hole -- this method just makes sure there is nothing here (a thrown `ERR_`, a
   * different return shape) for that route to leak by accident.
   *
   * The deactivated/restricted checks are also what stops a reset token from ever being minted for
   * such an account: `afterLoginChecks()` (via `resetPassword()`) would refuse the login anyway, but
   * only after the password hash has already been rewritten -- refusing here means a token never
   * exists to redeem in the first place.
   */
  async forgotPassword({
    strategyId,
    email
  }: {
    strategyId: string
    email: string
  }): Promise<void> {
    const strategy = await WIKI.models.authentication.getStrategyById(strategyId)
    if (!strategy?.isEnabled || strategy.config?.allowForgotPassword !== true) {
      WIKI.models.flags.authDebug(
        `Forgot-password request against strategy ${strategyId}, which does not allow resets`
      )
      return
    }

    const user = await WIKI.models.users.getByEmail(email.toLowerCase().trim())
    const auth = (user?.auth ?? {}) as Record<string, any>
    if (!user || !auth[strategyId]?.password || !user.isActive || auth[strategyId].restrictLogin) {
      WIKI.models.flags.authDebug(
        `Forgot-password request for an address with no matching, resettable local account under strategy ${strategyId}`
      )
      return
    }

    const token = await WIKI.models.userCredentials.generateToken({
      kind: 'resetPwd',
      userId: user.id,
      meta: { strategyId }
    })
    await WIKI.models.mail.sendForgotPassword({
      to: user.email,
      name: user.name,
      token,
      locale: (user.prefs as Record<string, any> | undefined)?.locale
    })
    WIKI.models.flags.authDebug(`Password reset link sent to user ${user.id} <${user.email}>`)
  }

  /**
   * Finish a password reset from the `forgotPassword()` email link.
   *
   * Signs the user straight in on success, exactly like every other token-continuation flow in this
   * file (`loginChangePassword()`, `loginTFA()`, `register()` with `emailValidation` off) -- there is
   * no separate "now log in again" step, since possessing a working reset token already proves control
   * of the account's email address.
   *
   * Deliberately NOT `skipTFA`, though: unlike `loginChangePassword()`'s continuation token (only
   * reachable after a login attempt has already cleared 2FA earlier in the same flow), a reset token
   * is minted straight from an email address with no password or 2FA code involved at all. Skipping TFA
   * here would let anyone with access to the mailbox alone sign all the way in on an account that has
   * 2FA active; `afterLoginChecks()` still asks for a code first when it does.
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
      await WIKI.models.userCredentials.validateToken({
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
    await WIKI.models.userCredentials.patchStrategyAuth(
      user.id,
      strategyId,
      () => ({ password: passwordHash, mustChangePwd: false }),
      { mirrorInto: user }
    )

    try {
      await WIKI.models.mail.sendPasswordResetConfirmed({
        to: user.email,
        name: user.name,
        locale: user.prefs?.locale
      })
    } catch (err: any) {
      // -> The password change already succeeded; a failed notice email must not turn this into a
      //    failed reset
      WIKI.logger.warn(
        `Failed to send the password-reset-confirmed notice to ${user.email}: ${err.message}`
      )
    }

    return this.afterLoginChecks(user, strategyId, { ip, siteId }, { skipChangePwd: true }, req)
  }
}

export const login = new Login()
