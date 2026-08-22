import bcrypt from 'bcryptjs'
import QRCode from 'qrcode'
import {
  assets as assetsTable,
  authentication as authenticationTable,
  groups as groupsTable,
  pages as pagesTable,
  sessions as sessionsTable,
  userAvatars,
  userGroups,
  users as usersTable,
  userKeys
} from '../db/schema.ts'
import { and, count, desc, eq, ilike, inArray, isNotNull, notExists, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { flatten, uniq } from 'es-toolkit/array'
import { detectImageMime, resizeImageToSquareJpeg } from '../helpers/images.ts'
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from '../helpers/totp.ts'
import {
  generateRecoveryCodes,
  isRecoveryCodeShape,
  normalizeRecoveryCode
} from '../helpers/recoveryCodes.ts'
import { ProvisionableLoginError } from './authentication.ts'
import type { AuthStrategy, ProviderProfile } from './authentication.ts'
import type { SystemIds } from './types.ts'

/** The essential user fields, mirroring the `UserCore` API schema. */
export interface UserCore {
  id: string
  name: string
  email: string
  hasAvatar: boolean
  isSystem: boolean
  isActive: boolean
  isVerified: boolean
  createdAt: Date
  updatedAt: Date
  lastLoginAt: Date | null
}

/** One page of users, with the total matching the filter rather than the page size. */
export interface UserPage {
  total: number
  users: UserCore[]
}

/** A user and when they last signed in — all `getRecentLogins()` discloses. */
export interface RecentLogin {
  id: string
  name: string
  email: string
  lastLoginAt: Date | null
}

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

/** The subset of user fields that may be modified. `isSystem` is deliberately absent. */
export interface UserPatch {
  name?: string
  email?: string
  isActive?: boolean
  isVerified?: boolean
  meta?: Record<string, any>
  prefs?: Record<string, any>
}

/**
 * The self-service view of a user, flattening the `meta` and `prefs` blobs into the fields the
 * profile page shows. Mirrors the `UserProfile` API schema.
 */
export interface UserProfile {
  id: string
  name: string
  email: string
  hasAvatar: boolean
  location: string
  jobTitle: string
  pronouns: string
  timezone: string
  dateFormat: string
  timeFormat: string
  appearance: string
  cvd: string
}

/** The fields a user may change on its own profile. Notably not the email, nor any admin flag. */
export interface UserProfilePatch {
  name?: string
  location?: string
  jobTitle?: string
  pronouns?: string
  timezone?: string
  dateFormat?: string
  timeFormat?: string
  appearance?: string
  cvd?: string
}

/** The `meta` keys the profile owns, and the `prefs` keys it owns. */
const profileMetaKeys = ['location', 'jobTitle', 'pronouns'] as const
const profilePrefsKeys = ['timezone', 'dateFormat', 'timeFormat', 'appearance', 'cvd'] as const

/**
 * The square, in pixels, an avatar is resized to. The profile page and the account menu both display
 * one at 180px; nothing displays one larger.
 */
const avatarSize = 180

/**
 * Escape the LIKE wildcards `%` and `_` (and the escape character itself) so that a user-supplied
 * filter is matched literally. Values are still parameterized by the driver — this is about a `%`
 * in the filter silently matching everything, not about injection.
 */
function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/**
 * Count a wrong 2FA code against a continuation token, destroying the token once `maxTfaAttempts`
 * have been used up — the client then has nothing left to continue with and has to start over.
 *
 * A token that has already been destroyed, or never existed, is not an error here: the caller is
 * about to reject the attempt either way.
 */
async function countTfaFailure(token: string): Promise<void> {
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

/** Cost factor `bcrypt` hashes recovery codes at — the same one `models/users.ts` hashes passwords with. */
const recoveryCodeBcryptRounds = 12

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
      hash: await bcrypt.hash(normalizeRecoveryCode(code), recoveryCodeBcryptRounds),
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

/** Selection shared by the list / detail queries. Never includes `auth` or `passkeys`. */
const userSelection = {
  id: usersTable.id,
  name: usersTable.name,
  email: usersTable.email,
  hasAvatar: usersTable.hasAvatar,
  isSystem: usersTable.isSystem,
  isActive: usersTable.isActive,
  isVerified: usersTable.isVerified,
  createdAt: usersTable.createdAt,
  updatedAt: usersTable.updatedAt,
  lastLoginAt: usersTable.lastLoginAt
}

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
 * What `importLocalUser()` resolves with — the email-collision policy (see that method's doc) is
 * part of the return value, not just a thrown error, so a bulk import can report *why* a record
 * didn't land instead of treating a collision as an unhandled failure.
 */
export type ImportLocalUserResult =
  | { status: 'created'; id: string }
  | { status: 'skipped'; reason: 'email-collision'; existingId: string }

/**
 * Users model
 */
class Users {
  async getByEmail(email: string) {
    const res = await WIKI.db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1)
    return res?.[0] ?? null
  }

  async getById(id: string) {
    const res = await WIKI.db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1)
    return res?.[0] ?? null
  }

  /**
   * Fetch the users who logged in most recently, most recent first.
   *
   * Identity and the moment only — this answers a dashboard panel readable by anyone in the admin area,
   * which is a tier below the `read:users` that the user list itself needs, so it deliberately carries
   * none of the account state `getUsers()` selects.
   *
   * An account that has never logged in has no place in the answer rather than trailing the end of it,
   * hence the `isNotNull`. System accounts are excluded because the guest is one: nothing signs in as
   * it, and a `lastLoginAt` on it would be an artefact rather than a visit.
   *
   * @param limit How many to return
   * @returns The most recent logins, newest first
   */
  async getRecentLogins({ limit = 10 }: { limit?: number } = {}): Promise<RecentLogin[]> {
    return WIKI.db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        lastLoginAt: usersTable.lastLoginAt
      })
      .from(usersTable)
      .where(and(isNotNull(usersTable.lastLoginAt), eq(usersTable.isSystem, false)))
      .orderBy(desc(usersTable.lastLoginAt))
      .limit(limit)
  }

  /**
   * Fetch a page of users, optionally filtered by name or email
   *
   * @param filter Matched literally against name and email, case-insensitively
   * @param assignableToGroupId Keep only the users that may be assigned to this group
   * @returns The page of users plus the total number matching the filter
   */
  async getUsers({
    filter = '',
    assignableToGroupId = '',
    page = 1,
    limit = 20
  }: {
    filter?: string
    assignableToGroupId?: string
    page?: number
    limit?: number
  } = {}): Promise<UserPage> {
    const conditions = []
    if (filter) {
      const pattern = `%${escapeLikePattern(filter)}%`
      conditions.push(or(ilike(usersTable.name, pattern), ilike(usersTable.email, pattern))!)
    }
    if (assignableToGroupId) {
      // -> Members of the group have nothing left to assign, and system users (the guest account)
      //    have a fixed membership that `POST /groups/:id/users/:id` refuses to change
      conditions.push(eq(usersTable.isSystem, false))
      conditions.push(
        notExists(
          WIKI.db
            .select({ exists: sql`1` })
            .from(userGroups)
            .where(
              and(eq(userGroups.userId, usersTable.id), eq(userGroups.groupId, assignableToGroupId))
            )
        )
      )
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const totals = await WIKI.db.select({ total: count() }).from(usersTable).where(where)
    const users = await WIKI.db
      .select(userSelection)
      .from(usersTable)
      .where(where)
      .orderBy(usersTable.name)
      .limit(limit)
      .offset((page - 1) * limit)

    return {
      total: totals[0]?.total ?? 0,
      users
    }
  }

  /**
   * Fetch a single user with the groups it belongs to and the authentication providers linked to it.
   *
   * The stored `auth` blob is keyed by strategy ID and holds secrets, so it is reshaped into a list
   * of providers carrying only state (`isPasswordSet`, `isTfaSetup`) — never the password hash or
   * the TFA secret.
   *
   * @param id User ID
   * @returns The user, or null if no such user exists
   */
  async getUserDetail(id: string) {
    const results = await WIKI.db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1)
    const user = results[0]
    if (!user) {
      return null
    }

    const groups = await this.getUserGroups(id)

    const strategies = await WIKI.db.select().from(authenticationTable)
    const auth: UserAuthProvider[] = []
    for (const [strategyId, rawConfig] of Object.entries(
      (user.auth ?? {}) as Record<string, any>
    )) {
      const strategy = strategies.find((s: any) => s.id === strategyId)
      const definition = WIKI.data.authentication?.find((d: any) => d.key === strategy?.module)
      const { password, tfaSecret, tfaIsActive, tfaRequired, recoveryCodes, ...config } =
        rawConfig ?? {}
      auth.push({
        authId: strategyId,
        authName: strategy?.displayName || definition?.title || strategy?.module || 'Unknown',
        strategyKey: strategy?.module ?? 'unknown',
        strategyIcon: definition?.icon ?? '',
        config: {
          ...config,
          isPasswordSet: Boolean(password),
          // -> Named as the profile page's own view names them, so one piece of state is not called two
          //    things across the API. Whether 2FA is set up is `tfaIsActive` and a stored secret both:
          //    a secret that was generated but never confirmed is not 2FA being on.
          isTfaSetup: Boolean(tfaIsActive && tfaSecret),
          isTfaRequired: Boolean(tfaRequired),
          recoveryCodesRemaining: tfaIsActive
            ? ((recoveryCodes ?? []) as RecoveryCodeEntry[]).filter((entry) => !entry.usedAt).length
            : 0
        }
      })
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      hasAvatar: user.hasAvatar,
      isSystem: user.isSystem,
      isActive: user.isActive,
      isVerified: user.isVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
      meta: user.meta,
      prefs: user.prefs,
      auth,
      groups
    }
  }

  /**
   * Create a new user, authenticated against the local strategy.
   *
   * @returns The new user's ID
   */
  async createUser({
    name,
    email,
    password,
    groups = [],
    mustChangePassword = false,
    isVerified = true
  }: {
    name: string
    email: string
    password: string
    groups?: string[]
    mustChangePassword?: boolean
    /**
     * Defaults to true: an administrator creating the account vouches for the address, and login
     * rejects unverified users with `ERR_USER_NOT_VERIFIED` — which no email can currently clear.
     */
    isVerified?: boolean
  }): Promise<string> {
    const localStrategyId = WIKI.data.systemIds.localAuthId
    const result = await WIKI.db
      .insert(usersTable)
      .values({
        email: email.toLowerCase(),
        name,
        auth: {
          [localStrategyId]: {
            password: await bcrypt.hash(password, 12),
            mustChangePwd: mustChangePassword,
            restrictLogin: false,
            tfaIsActive: false,
            tfaRequired: false,
            tfaSecret: ''
          }
        },
        isSystem: false,
        isActive: true,
        isVerified,
        meta: {
          location: '',
          jobTitle: '',
          pronouns: ''
        },
        prefs: {
          // -> Seeded from the instance-wide user defaults, which an administrator can change
          timezone: WIKI.config.userDefaults?.timezone ?? 'America/New_York',
          dateFormat: WIKI.config.userDefaults?.dateFormat ?? 'YYYY-MM-DD',
          timeFormat: WIKI.config.userDefaults?.timeFormat ?? '12h',
          appearance: 'site',
          cvd: 'none'
        }
      })
      .returning({ id: usersTable.id })

    const userId = result[0].id
    if (groups.length > 0) {
      await this.setUserGroups(userId, groups)
    }

    WIKI.models.flags.authDebug(
      `Created user ${userId} <${email.toLowerCase()}> in ${groups.length} group(s), mustChangePwd: ${mustChangePassword}, verified: ${isVerified}`
    )

    // -> No site context: an account is a global entity, not one the wiki can attribute to a site. A
    //    hook scoped to one site must not fire on every join instance-wide just because there is no
    //    site to compare against, so `null` here, not the first/current site.
    await WIKI.models.hooks.emit('user:join', null, {
      userId,
      metadata: {
        name,
        email: email.toLowerCase()
      }
    })

    return userId
  }

  /**
   * Create a local-provider user during a 2.5.x -> 3.0 import (Feature 414, Task 728), carrying an
   * already-hashed password over verbatim instead of hashing a plaintext one.
   *
   * ## Why this can't reuse `createUser()`
   * `createUser()` calls `bcrypt.hash(password, 12)` on whatever string it receives. A 2.5.x
   * local-provider `users.password` column is already a bcryptjs hash at 12 rounds — hashing it
   * again would produce a value that can never match the original plaintext, silently locking every
   * imported local account out of its own password. This method takes `passwordHash` and writes it
   * straight into `auth[localStrategyId].password`; nothing in its body calls `bcrypt.hash()`.
   *
   * ## Email-collision policy — explicit decision: skip-and-flag
   * `users.email` is unique (`db/schema.ts`). Importing into a non-empty 3.0 install (an
   * administrator's own account, or a previous partial/retried import run) can therefore collide.
   * The policy here is **skip-and-flag**: on collision this returns `{ status: 'skipped', reason:
   * 'email-collision', existingId }` instead of throwing or silently overwriting the existing
   * account. "Never a silent partial import" rules out picking a winner without saying so; the
   * caller (the users/groups importer engine) is responsible for turning this into a reported
   * `skipped` record rather than swallowing it. The check-then-insert has a narrow race window
   * (another writer between the check and this insert), so a `23505` unique-violation from the
   * insert itself is downgraded to the same skip result as a backstop, rather than surfaced as a
   * generic `conflicted` failure — a same-email race is still a collision, not a schema error.
   *
   * ## 2FA carryover — explicit decision: NOT carried over, always reset
   * 2.5.x `tfaIsActive`/`tfaSecret` are deliberately **not** accepted by this method at all (there is
   * no parameter for them) — every imported local account starts with 2FA off
   * (`tfaIsActive: false`, `tfaSecret: ''`) and can re-enroll after import. A TOTP secret is tied to
   * whichever authenticator app instance the user already enrolled on the source install; carrying
   * it over as "active" either (a) silently disables real 2FA protection if the secret is stale or
   * was rotated since, giving a false sense of security, or (b) if it still matches, moves a secret
   * across an infrastructure boundary (old install -> new install) without the user's awareness or
   * re-consent. Feature 414's framing does not mention re-notifying users or forcing 2FA
   * re-enrollment post-import, so resetting is the safer default until a real product decision says
   * otherwise — that decision is out of this task's scope, not silently assumed away.
   *
   * @returns `{ status: 'created', id }`, or `{ status: 'skipped', reason: 'email-collision',
   * existingId }` when a user with this email already exists.
   */
  async importLocalUser({
    name,
    email,
    passwordHash,
    groups = [],
    mustChangePassword = false,
    isVerified = true
  }: {
    name: string
    email: string
    /** The source install's already-hashed local password (bcryptjs, 12 rounds) — copied verbatim. */
    passwordHash: string
    /** Target-install group UUIDs, already remapped through the source-id -> target-UUID map built
     * while importing groups (see `migration/importers/users-groups.ts`). */
    groups?: string[]
    mustChangePassword?: boolean
    isVerified?: boolean
  }): Promise<ImportLocalUserResult> {
    const normalizedEmail = email.toLowerCase()

    const existing = await this.getByEmail(normalizedEmail)
    if (existing) {
      return { status: 'skipped', reason: 'email-collision', existingId: existing.id }
    }

    const localStrategyId = WIKI.data.systemIds.localAuthId
    let result
    try {
      result = await WIKI.db
        .insert(usersTable)
        .values({
          email: normalizedEmail,
          name,
          auth: {
            [localStrategyId]: {
              password: passwordHash,
              mustChangePwd: mustChangePassword,
              restrictLogin: false,
              tfaIsActive: false,
              tfaRequired: false,
              tfaSecret: ''
            }
          },
          isSystem: false,
          isActive: true,
          isVerified,
          meta: {
            location: '',
            jobTitle: '',
            pronouns: ''
          },
          prefs: {
            timezone: WIKI.config.userDefaults?.timezone ?? 'America/New_York',
            dateFormat: WIKI.config.userDefaults?.dateFormat ?? 'YYYY-MM-DD',
            timeFormat: WIKI.config.userDefaults?.timeFormat ?? '12h',
            appearance: 'site',
            cvd: 'none'
          }
        })
        .returning({ id: usersTable.id })
    } catch (err: any) {
      // -> See the collision-policy note above: a race between the pre-check and this insert still
      //    surfaces as the same skip result, not a generic thrown failure.
      if (err.cause?.code === '23505' || err.code === '23505') {
        return { status: 'skipped', reason: 'email-collision', existingId: '' }
      }
      throw err
    }

    const userId = result[0].id
    if (groups.length > 0) {
      await this.setUserGroups(userId, groups)
    }

    WIKI.models.flags.authDebug(
      `Imported local user ${userId} <${normalizedEmail}> in ${groups.length} group(s), mustChangePwd: ${mustChangePassword}`
    )

    await WIKI.models.hooks.emit('user:join', null, {
      userId,
      metadata: {
        name,
        email: normalizedEmail
      }
    })

    return { status: 'created', id: userId }
  }

  /**
   * Update a user's own fields. Group membership is handled by `setUserGroups()`.
   *
   * @param patch Fields to change — must not be empty
   * @returns Whether a user was updated
   */
  async updateUser(id: string, patch: UserPatch): Promise<boolean> {
    const values: Record<string, any> = { ...patch, updatedAt: sql`now()` }
    if (typeof values.email === 'string') {
      values.email = values.email.toLowerCase()
    }
    const result = await WIKI.db.update(usersTable).set(values).where(eq(usersTable.id, id))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * The profile of a single user, as shown on its own profile page.
   *
   * `meta` and `prefs` are free-form blobs, so every field is defaulted here rather than trusted to
   * be present — a user created before a given key existed simply has none.
   *
   * @returns The profile, or null if no such user exists
   */
  async getProfile(id: string): Promise<UserProfile | null> {
    const user = await this.getById(id)
    if (!user) {
      return null
    }
    const meta = (user.meta ?? {}) as Record<string, any>
    const prefs = (user.prefs ?? {}) as Record<string, any>
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      hasAvatar: user.hasAvatar,
      location: meta.location ?? '',
      jobTitle: meta.jobTitle ?? '',
      pronouns: meta.pronouns ?? '',
      // -> An empty time zone / date format means "whatever the client resolves", which is what the
      //    profile page falls back to
      timezone: prefs.timezone ?? '',
      dateFormat: prefs.dateFormat ?? '',
      timeFormat: prefs.timeFormat ?? '12h',
      appearance: prefs.appearance ?? 'site',
      cvd: prefs.cvd ?? 'none'
    }
  }

  /**
   * A user's own settings for one editor.
   *
   * Kept under `prefs.editors[editor]` so each editor owns its own blob and adding a second one
   * needs no migration. The shape is whatever that editor saves; this only guarantees an object.
   *
   * @returns The saved settings, or `{}` for a user who has never saved any
   */
  async getEditorSettings(id: string, editor: string): Promise<Record<string, any>> {
    const user = await this.getById(id)
    if (!user) {
      return {}
    }
    const prefs = (user.prefs ?? {}) as Record<string, any>
    return (prefs.editors?.[editor] ?? {}) as Record<string, any>
  }

  /**
   * Replace a user's settings for one editor.
   *
   * Merges at both levels for the same reason `updateProfile` does: another editor's settings, and
   * every other preference, have to survive one editor saving its own.
   *
   * @returns The saved settings, or null if no such user exists
   */
  async setEditorSettings(
    id: string,
    editor: string,
    config: Record<string, any>
  ): Promise<Record<string, any> | null> {
    const user = await this.getById(id)
    if (!user) {
      return null
    }
    const prefs = { ...((user.prefs ?? {}) as Record<string, any>) }
    prefs.editors = { ...((prefs.editors ?? {}) as Record<string, any>), [editor]: config }
    await this.updateUser(id, { prefs })
    return config
  }

  /**
   * Update a user's own profile fields, merging into the `meta` and `prefs` blobs rather than
   * replacing them — an administrator's notes and any key this endpoint does not expose must survive
   * a user saving its profile.
   *
   * @param patch Fields to change; omitted ones are left as they are
   * @returns The updated profile, or null if no such user exists
   */
  async updateProfile(id: string, patch: UserProfilePatch): Promise<UserProfile | null> {
    const user = await this.getById(id)
    if (!user) {
      return null
    }

    const meta = { ...((user.meta ?? {}) as Record<string, any>) }
    const prefs = { ...((user.prefs ?? {}) as Record<string, any>) }
    for (const key of profileMetaKeys) {
      if (patch[key] !== undefined) {
        meta[key] = patch[key]
      }
    }
    for (const key of profilePrefsKeys) {
      if (patch[key] !== undefined) {
        prefs[key] = patch[key]
      }
    }

    const values: UserPatch = { meta, prefs }
    if (patch.name !== undefined) {
      values.name = patch.name
    }
    await this.updateUser(id, values)

    return this.getProfile(id)
  }

  /**
   * A user's avatar, with the type its bytes say it is.
   *
   * The type is sniffed rather than stored: an avatar written while Sharp was installed is a JPEG,
   * one written without it is whatever was uploaded, and nothing records which. Unrecognizable bytes
   * are reported as JPEG, which is what every avatar stored by 2.x is.
   *
   * @returns The avatar, or null if this user has none
   */
  async getAvatar(userId: string): Promise<{ data: Buffer; mime: string } | null> {
    const rows = await WIKI.db
      .select({ data: userAvatars.data })
      .from(userAvatars)
      .where(eq(userAvatars.id, userId))
      .limit(1)
    const data = rows[0]?.data
    if (!data) {
      return null
    }
    return { data, mime: detectImageMime(data) ?? 'image/jpeg' }
  }

  /**
   * Replace a user's avatar.
   *
   * Normalized to a square JPEG when the Sharp extension is installed — an avatar is displayed at one
   * small size, so there is no reason to keep a multi-megabyte original around. Without Sharp the
   * uploaded bytes are stored as they came in, which is why reading one sniffs the type.
   *
   * @param data The uploaded image, already known to be one of the supported formats
   */
  async setAvatar(userId: string, data: Buffer): Promise<void> {
    const normalized = (await resizeImageToSquareJpeg(data, avatarSize)) ?? data
    await WIKI.db
      .insert(userAvatars)
      .values({ id: userId, data: normalized })
      .onConflictDoUpdate({ target: userAvatars.id, set: { data: normalized } })
    await WIKI.db
      .update(usersTable)
      .set({ hasAvatar: true, updatedAt: sql`now()` })
      .where(eq(usersTable.id, userId))
  }

  /**
   * Remove a user's avatar, leaving it to be rendered as initials again.
   */
  async clearAvatar(userId: string): Promise<void> {
    await WIKI.db.delete(userAvatars).where(eq(userAvatars.id, userId))
    await WIKI.db
      .update(usersTable)
      .set({ hasAvatar: false, updatedAt: sql`now()` })
      .where(eq(usersTable.id, userId))
  }

  /**
   * The groups a user belongs to, by name. Only the identity of each group — never its permissions or
   * page rules, which a user has no business reading about itself.
   */
  async getUserGroups(userId: string): Promise<Array<{ id: string; name: string }>> {
    return WIKI.db
      .select({ id: groupsTable.id, name: groupsTable.name })
      .from(userGroups)
      .innerJoin(groupsTable, eq(groupsTable.id, userGroups.groupId))
      .where(eq(userGroups.userId, userId))
      .orderBy(groupsTable.name)
  }

  /**
   * The IDs of the groups a user belongs to
   */
  async getUserGroupIds(userId: string): Promise<string[]> {
    const rows = await WIKI.db
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .where(eq(userGroups.userId, userId))
    return rows.map((r: any) => r.groupId)
  }

  /**
   * Replace a user's group membership with exactly the given groups.
   *
   * Unknown group IDs are ignored rather than failing the whole update, so that a stale client does
   * not block an otherwise valid save. So is a membership that may not exist — see
   * `groups.guestMembershipViolation`: this is the one call that sets every group at once, and it is
   * reached from creating a user, editing one, and enrolling one that an identity provider has just
   * sent. Dropping what may not be granted keeps all three honest without any of them having to know
   * about the guests group.
   */
  async setUserGroups(userId: string, groupIds: string[]): Promise<void> {
    const user = await this.getById(userId)
    const allowed = groupIds.filter(
      (groupId) => !WIKI.models.groups.guestMembershipViolation(groupId, user)
    )
    if (allowed.length !== groupIds.length) {
      WIKI.logger.warn(
        `Dropped ${groupIds.length - allowed.length} group assignment(s) for user ${userId} that may not be granted.`
      )
    }
    /*
      The guest account keeps the membership it was seeded with whatever was asked for: it is the one
      user whose groups are not an administrator's to set, and an empty list would otherwise leave
      anonymous access resolving against no rules at all.
    */
    if (user?.isSystem) {
      return
    }

    const wanted =
      allowed.length > 0
        ? await WIKI.db
            .select({ id: groupsTable.id })
            .from(groupsTable)
            .where(inArray(groupsTable.id, allowed))
        : []
    const wantedIds = wanted.map((g: any) => g.id)

    await WIKI.db.delete(userGroups).where(eq(userGroups.userId, userId))
    if (wantedIds.length > 0) {
      await WIKI.db
        .insert(userGroups)
        .values(wantedIds.map((groupId: string) => ({ userId, groupId })))
    }
  }

  /**
   * Update the local-strategy behaviour flags for a user, leaving secrets and any other linked
   * provider untouched.
   *
   * @param flags Any of `mustChangePwd`, `restrictLogin`, `tfaRequired`
   * @returns False if the user does not exist
   */
  async setUserAuthFlags(id: string, flags: Record<string, any>): Promise<boolean> {
    const user = await this.getById(id)
    if (!user) {
      return false
    }

    const localStrategyId = WIKI.data.systemIds.localAuthId
    const auth = (user.auth ?? {}) as Record<string, any>
    const current = auth[localStrategyId]
    if (!current) {
      // -> The user does not use local authentication, so there are no local flags to set
      return false
    }

    for (const key of ['mustChangePwd', 'restrictLogin', 'tfaRequired'] as const) {
      if (flags[key] !== undefined) {
        current[key] = Boolean(flags[key])
      }
    }
    auth[localStrategyId] = current

    await WIKI.db
      .update(usersTable)
      .set({ auth, updatedAt: sql`now()` })
      .where(eq(usersTable.id, id))
    return true
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
    const user = await this.getById(id)
    if (!user) {
      return false
    }

    const localStrategyId = WIKI.data.systemIds.localAuthId
    const auth = (user.auth ?? {}) as Record<string, any>
    auth[localStrategyId] = {
      ...auth[localStrategyId],
      password: await bcrypt.hash(newPassword, 12),
      mustChangePwd: mustChangePassword
    }

    await WIKI.db
      .update(usersTable)
      .set({ auth, updatedAt: sql`now()` })
      .where(eq(usersTable.id, id))
    return true
  }

  /**
   * The authentication providers linked to a user, as its own profile page shows them.
   *
   * Reshaped from the stored `auth` blob the same way `getUserDetail()` does it, but reporting only
   * what the user may act on. `isTfaRequired` is what greys out the "turn off 2FA" button, so it
   * accounts for the strategy enforcing 2FA for everyone as well as this user being flagged for it.
   */
  async getProfileAuthMethods(userId: string): Promise<UserProfileAuthMethod[]> {
    const user = await this.getById(userId)
    if (!user) {
      return []
    }

    const strategies = await WIKI.db.select().from(authenticationTable)
    const methods: UserProfileAuthMethod[] = []
    for (const [strategyId, rawConfig] of Object.entries(
      (user.auth ?? {}) as Record<string, any>
    )) {
      const strategy = strategies.find((s: any) => s.id === strategyId)
      const definition = WIKI.data.authentication?.find((d: any) => d.key === strategy?.module)
      const config = rawConfig ?? {}
      methods.push({
        authId: strategyId,
        authName: strategy?.displayName || definition?.title || strategy?.module || 'Unknown',
        strategyKey: strategy?.module ?? 'unknown',
        strategyIcon: definition?.icon ?? '',
        config: {
          isPasswordSet: Boolean(config.password),
          isTfaSetup: Boolean(config.tfaIsActive && config.tfaSecret),
          isTfaRequired: Boolean(
            config.tfaRequired || (strategy?.config as Record<string, any>)?.enforceTfa
          ),
          isPasswordLoginEnabled: !config.restrictLogin,
          canDisablePasswordLogin: countAlternativeLogins(user, strategyId) > 0,
          recoveryCodesRemaining: config.tfaIsActive
            ? ((config.recoveryCodes ?? []) as RecoveryCodeEntry[]).filter((entry) => !entry.usedAt)
                .length
            : 0
        }
      })
    }
    return methods
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
    const user = await this.getById(userId)
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

    auth[strategyId] = {
      ...auth[strategyId],
      password: await bcrypt.hash(newPassword, 12),
      mustChangePwd: false
    }
    await WIKI.db
      .update(usersTable)
      .set({ auth, updatedAt: sql`now()` })
      .where(eq(usersTable.id, userId))
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
    const user = await this.getById(userId)
    if (!user) {
      throw new Error('ERR_INVALID_USER')
    }
    const auth = (user.auth ?? {}) as Record<string, any>
    if (!auth[strategyId]) {
      throw new Error('ERR_INVALID_STRATEGY')
    }

    // -> The flag is only ever read by the local module's `authenticate()`, so setting it on a provider
    //    that authenticates elsewhere would be a switch connected to nothing
    const strategy = await WIKI.models.authentication.getStrategyById(strategyId)
    if (strategy?.module !== 'local' || !auth[strategyId].password) {
      throw new Error('ERR_PASSWORD_LOGIN_NOT_APPLICABLE')
    }

    if (!isEnabled && countAlternativeLogins(user, strategyId) < 1) {
      throw new Error('ERR_NO_OTHER_LOGIN_METHOD')
    }

    auth[strategyId] = { ...auth[strategyId], restrictLogin: !isEnabled }
    await WIKI.db
      .update(usersTable)
      .set({ auth, updatedAt: sql`now()` })
      .where(eq(usersTable.id, userId))

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
    user.auth = (user.auth ?? {}) as Record<string, any>
    user.auth[strategyId] = {
      ...user.auth[strategyId],
      tfaSecret: secret,
      tfaIsActive: false
    }
    await WIKI.db
      .update(usersTable)
      .set({ auth: user.auth, updatedAt: sql`now()` })
      .where(eq(usersTable.id, user.id))

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
    user.auth[strategyId] = {
      ...user.auth[strategyId],
      tfaIsActive: true,
      recoveryCodes: entries
    }
    await WIKI.db
      .update(usersTable)
      .set({ auth: user.auth, updatedAt: sql`now()` })
      .where(eq(usersTable.id, user.id))
    WIKI.models.flags.authDebug(`User ${user.id} <${user.email}> enabled 2FA`)
    return plaintext
  }

  /**
   * Turn 2FA off for a user and forget the secret, so that setting it up again starts from a new one.
   *
   * @throws `ERR_INVALID_USER`, `ERR_INVALID_STRATEGY`, `ERR_TFA_NOT_ACTIVE` or `ERR_TFA_ENFORCED`
   */
  async disableTfa(userId: string, strategyId: string): Promise<void> {
    const user = await this.getById(userId)
    if (!user) {
      throw new Error('ERR_INVALID_USER')
    }
    const auth = (user.auth ?? {}) as Record<string, any>
    if (!auth[strategyId]) {
      throw new Error('ERR_INVALID_STRATEGY')
    }
    if (!auth[strategyId].tfaIsActive) {
      throw new Error('ERR_TFA_NOT_ACTIVE')
    }

    // -> Turning it off would be undone at the next login, which is worth an error rather than a
    //    confusing round trip. The client greys the button out, but that is a client.
    const strategy = await WIKI.models.authentication.getStrategyById(strategyId)
    if (auth[strategyId].tfaRequired || (strategy?.config as Record<string, any>)?.enforceTfa) {
      throw new Error('ERR_TFA_ENFORCED')
    }

    auth[strategyId] = { ...auth[strategyId], tfaIsActive: false, tfaSecret: '', recoveryCodes: [] }
    await WIKI.db
      .update(usersTable)
      .set({ auth, updatedAt: sql`now()` })
      .where(eq(usersTable.id, userId))
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
    const user = await this.getById(userId)
    if (!user) {
      throw new Error('ERR_INVALID_USER')
    }
    const auth = (user.auth ?? {}) as Record<string, any>
    if (!auth[strategyId]) {
      throw new Error('ERR_INVALID_STRATEGY')
    }
    if (!auth[strategyId].tfaIsActive) {
      throw new Error('ERR_TFA_NOT_ACTIVE')
    }

    auth[strategyId] = { ...auth[strategyId], tfaIsActive: false, tfaSecret: '', recoveryCodes: [] }
    await WIKI.db
      .update(usersTable)
      .set({ auth, updatedAt: sql`now()` })
      .where(eq(usersTable.id, userId))
    WIKI.models.flags.authDebug(
      `User ${userId} <${user.email}> had 2FA invalidated by an administrator`
    )
  }

  /**
   * Whether a security code matches the 2FA secret stored for a user under one strategy.
   */
  verifyTfaCode(user: any, strategyId: string, securityCode: string): boolean {
    const secret = ((user.auth ?? {}) as Record<string, any>)[strategyId]?.tfaSecret
    return Boolean(secret) && verifyTotpCode(secret, securityCode)
  }

  /**
   * Whether a recovery code matches one of the unconsumed codes stored for a user's 2FA. On a match,
   * marks that entry consumed so it cannot be redeemed a second time.
   *
   * @param user The user row, whose `auth` blob is updated in place as well as saved
   * @returns Whether the code matched an unconsumed entry
   */
  async verifyAndConsumeRecoveryCode(
    user: any,
    strategyId: string,
    code: string
  ): Promise<boolean> {
    const auth = (user.auth ?? {}) as Record<string, any>
    const entries = (auth[strategyId]?.recoveryCodes ?? []) as RecoveryCodeEntry[]
    const matchedIndex = await matchRecoveryCode(entries, normalizeRecoveryCode(code))
    if (matchedIndex < 0) {
      return false
    }

    const updatedEntries = entries.map((entry, i) =>
      i === matchedIndex
        ? { ...entry, usedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }) }
        : entry
    )
    user.auth[strategyId] = { ...auth[strategyId], recoveryCodes: updatedEntries }
    await WIKI.db
      .update(usersTable)
      .set({ auth: user.auth, updatedAt: sql`now()` })
      .where(eq(usersTable.id, user.id))
    WIKI.models.flags.authDebug(`User ${user.id} <${user.email}> consumed a 2FA recovery code`)
    return true
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
    const user = await this.getById(userId)
    if (!user) {
      throw new Error('ERR_INVALID_USER')
    }
    const auth = (user.auth ?? {}) as Record<string, any>
    if (!auth[strategyId]) {
      throw new Error('ERR_INVALID_STRATEGY')
    }
    // -> No 2FA, no codes: rather than answering `{ total: 0, remaining: 0 }` for an account that
    //    was never set up for recovery codes in the first place, this is treated the same as any
    //    other 2FA-inactive request.
    if (!auth[strategyId].tfaIsActive) {
      throw new Error('ERR_TFA_NOT_ACTIVE')
    }
    const entries = (auth[strategyId].recoveryCodes ?? []) as RecoveryCodeEntry[]
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
    const user = await this.getById(userId)
    if (!user) {
      throw new Error('ERR_INVALID_USER')
    }
    const auth = (user.auth ?? {}) as Record<string, any>
    if (!auth[strategyId]) {
      throw new Error('ERR_INVALID_STRATEGY')
    }
    if (!auth[strategyId].tfaIsActive) {
      throw new Error('ERR_TFA_NOT_ACTIVE')
    }

    const previousEntries = (auth[strategyId].recoveryCodes ?? []) as RecoveryCodeEntry[]
    const hadUnusedCodes = previousEntries.some((entry) => !entry.usedAt)

    const { plaintext, entries } = await issueRecoveryCodes()
    auth[strategyId] = { ...auth[strategyId], recoveryCodes: entries }
    await WIKI.db
      .update(usersTable)
      .set({ auth, updatedAt: sql`now()` })
      .where(eq(usersTable.id, userId))
    WIKI.models.flags.authDebug(
      `User ${userId} <${user.email}> regenerated their 2FA recovery codes`
    )
    return { recoveryCodes: plaintext, hadUnusedCodes }
  }

  /**
   * Bulk-reassign every page and asset `fromUserId` authored to `toUserId`, in one transaction.
   *
   * `pages.authorId`/`creatorId`/`ownerId` and `assets.authorId` are the only columns referencing
   * `users.id` with no `onDelete` cascade or `set null` (see `db/schema.ts`), which is exactly why
   * `deleteUser()` throws a foreign key violation for a user who authored, created, or owns any page,
   * or authored any asset. This is the whole of what clears that violation: once no row names
   * `fromUserId` in one of those columns, `deleteUser()` has nothing left to point at it.
   *
   * A single page can carry `fromUserId` in more than one of its three columns at once (e.g. as both
   * author and owner), so `pages` is updated with one statement that repoints only the columns that
   * actually match, rather than three separate statements that would each report the same page as
   * touched.
   *
   * @returns How many pages and assets were reassigned
   */
  async reassignContent(
    fromUserId: string,
    toUserId: string
  ): Promise<{ pagesReassigned: number; assetsReassigned: number }> {
    if (fromUserId === toUserId) {
      throw new Error('ERR_REASSIGN_SAME_USER')
    }
    const target = await this.getById(toUserId)
    if (!target) {
      throw new Error('ERR_INVALID_USER')
    }
    if (target.isSystem) {
      throw new Error('ERR_REASSIGN_TARGET_IS_SYSTEM')
    }

    return WIKI.db.transaction(async (tx) => {
      const pagesResult = await tx
        .update(pagesTable)
        .set({
          authorId: sql`CASE WHEN ${pagesTable.authorId} = ${fromUserId} THEN ${toUserId}::uuid ELSE ${pagesTable.authorId} END`,
          creatorId: sql`CASE WHEN ${pagesTable.creatorId} = ${fromUserId} THEN ${toUserId}::uuid ELSE ${pagesTable.creatorId} END`,
          ownerId: sql`CASE WHEN ${pagesTable.ownerId} = ${fromUserId} THEN ${toUserId}::uuid ELSE ${pagesTable.ownerId} END`
        })
        .where(
          or(
            eq(pagesTable.authorId, fromUserId),
            eq(pagesTable.creatorId, fromUserId),
            eq(pagesTable.ownerId, fromUserId)
          )
        )
      const assetsResult = await tx
        .update(assetsTable)
        .set({ authorId: toUserId })
        .where(eq(assetsTable.authorId, fromUserId))

      return {
        pagesReassigned: pagesResult.rowCount ?? 0,
        assetsReassigned: assetsResult.rowCount ?? 0
      }
    })
  }

  /**
   * Delete a user.
   *
   * Group assignments cascade, but sessions and keys do not — they are login artifacts, so they are
   * cleared here rather than blocking the delete. References from authored content (pages, assets)
   * have no cascade either and will make this throw, which is deliberate: the delete is refused
   * rather than silently orphaning content.
   *
   * @returns Whether a user was deleted
   */
  async deleteUser(id: string): Promise<boolean> {
    await WIKI.db.delete(userKeys).where(eq(userKeys.userId, id))
    await WIKI.db.delete(sessionsTable).where(eq(sessionsTable.userId, id))
    const result = await WIKI.db.delete(usersTable).where(eq(usersTable.id, id))
    return (result.rowCount ?? 0) > 0
  }

  async init(ids: SystemIds): Promise<void> {
    WIKI.logger.info('Inserting default users...')

    await WIKI.db.insert(usersTable).values([
      {
        id: ids.userAdminId,
        email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
        auth: {
          [ids.authModuleId]: {
            password: await bcrypt.hash(process.env.ADMIN_PASS || '12345678', 12),
            mustChangePwd: !process.env.ADMIN_PASS,
            restrictLogin: false,
            tfaIsActive: false,
            tfaRequired: false,
            tfaSecret: ''
          }
        },
        name: 'Administrator',
        isSystem: false,
        isActive: true,
        isVerified: true,
        meta: {
          location: '',
          jobTitle: '',
          pronouns: ''
        },
        prefs: {
          timezone: 'America/New_York',
          dateFormat: 'YYYY-MM-DD',
          timeFormat: '12h',
          appearance: 'site',
          cvd: 'none'
        }
      },
      {
        id: ids.userGuestId,
        email: 'guest@example.com',
        auth: {},
        name: 'Guest',
        isSystem: true,
        isActive: true,
        isVerified: true,
        meta: {},
        prefs: {
          timezone: 'America/New_York',
          dateFormat: 'YYYY-MM-DD',
          timeFormat: '12h',
          appearance: 'site',
          cvd: 'none'
        }
      }
    ])

    await WIKI.db.insert(userGroups).values([
      {
        userId: ids.userAdminId,
        groupId: ids.groupAdminId
      },
      {
        userId: ids.userGuestId,
        groupId: ids.groupGuestId
      }
    ])
  }

  async login(
    { siteId, strategyId, username, password, ip }: LoginOptions,
    req: any
  ): Promise<AfterLoginResult> {
    if (strategyId in WIKI.auth.strategies) {
      const str = WIKI.auth.strategies[strategyId] as any
      const strInfo = WIKI.data.authentication.find((a: any) => a.key === str.module)
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
          login. `findOrCreateProviderUser()` enforces `registration` itself, and only for the case
          that actually needs it: an unknown address with no local account. Gating on it *here* as well
          would refuse a returning user who already has an account the moment `registration` is turned
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
   * The email address is the identity: a provider's own `id` is recorded so that an address changing
   * upstream does not orphan the account, but matching starts with the address because that is what
   * an administrator invited, what a group rule was written against, and what every other strategy
   * keys on. A module must therefore only ever report an address it has established belongs to the
   * person — see `ProviderProfile`.
   *
   * Registration is refused rather than silently allowed: a wiki that has not opened its doors to a
   * provider gets `ERR_REGISTRATION_DISABLED` for an unknown account, and one that has can still
   * limit who by, with the strategy's email allow-list pattern.
   *
   * @throws `ERR_REGISTRATION_DISABLED`, `ERR_EMAIL_NOT_ALLOWED`, `ERR_INACTIVE_USER`
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
      Neither 2FA nor a password change is asked for: both are the local strategy's, and this user has
      just proved who they are somewhere else — where whatever second factor that provider enforces has
      already been satisfied.
    */
    return this.afterLoginChecks(
      user,
      strategy.id,
      { ip, siteId },
      { skipTFA: true, skipChangePwd: true },
      req
    )
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
   * @throws `ERR_REGISTRATION_DISABLED`, `ERR_EMAIL_NOT_ALLOWED`, `ERR_LOGIN_FAILED`,
   *         `ERR_INACTIVE_USER`
   */
  private async findOrCreateProviderUser(
    strategy: AuthStrategy,
    profile: ProviderProfile
  ): Promise<any> {
    const email = profile.email.toLowerCase().trim()
    let user = await this.getByEmail(email)

    if (!user) {
      if (!strategy.registration) {
        WIKI.models.flags.authDebug(
          `Provider login for unknown address <${email}> refused: strategy ${strategy.id} does not accept new users`
        )
        throw new Error('ERR_REGISTRATION_DISABLED')
      }
      if (strategy.allowedEmailRegex) {
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
      const userId = await this.createUser({
        name: profile.name || email,
        email,
        // -> Nothing signs in with it: this account authenticates at the provider, and the local
        //    strategy's own entry is what a password would live under
        password: nanoid(32),
        groups: strategy.autoEnrollGroups ?? [],
        isVerified: true
      })
      user = await this.getById(userId)
      WIKI.models.flags.authDebug(
        `Created user ${userId} <${email}> from ${strategy.module} strategy ${strategy.id}`
      )
    }

    if (!user) {
      throw new Error('ERR_LOGIN_FAILED')
    }
    if (!user.isActive) {
      throw new Error('ERR_INACTIVE_USER')
    }

    /*
      The link between this account and the provider's, written on every login: it records which
      account at the provider this is, and it is what tells the profile page that this user signs in
      through this strategy.
    */
    const auth = (user.auth ?? {}) as Record<string, any>
    auth[strategy.id] = {
      ...auth[strategy.id],
      id: profile.id,
      email
    }
    user.auth = auth
    await WIKI.db
      .update(usersTable)
      .set({ auth, updatedAt: sql`now()` })
      .where(eq(usersTable.id, user.id))

    // -> Every login, not only the one that created the account: a group added or removed at the
    //    provider since the last login has to show up here too.
    if (strategy.config?.mapGroups && profile.groups) {
      await this.syncProviderGroups(user, strategy, profile.groups)
    }

    return user
  }

  /**
   * Reconcile a user's wiki group membership with the groups an identity provider just reported for
   * them, adding what is newly granted and removing what is no longer reported — mirroring 2.5.x's
   * `passport-ldapauth` / `passport-saml` modules' add/remove-by-difference behavior.
   *
   * Two memberships are never touched by this, regardless of what was reported:
   *
   *   - the guests group, which is anonymous access itself rather than something a provider can grant
   *     or take away from a real account;
   *   - any group still named in the strategy's own `autoEnrollGroups` — an administrator put that
   *     grant there directly, and a provider that has simply stopped mentioning the group should not
   *     silently undo it.
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
    const protectedFromRemoval = new Set([guestsGroupId, ...(strategy.autoEnrollGroups ?? [])])

    const reportedNames = new Set(
      reportedGroups.map((name) => name.trim().toLowerCase()).filter(Boolean)
    )
    const allGroups = await WIKI.models.groups.getAllGroups()
    const matchedGroupIds = new Set(
      allGroups
        .filter(
          (g: any) => g.id !== guestsGroupId && reportedNames.has(g.name.trim().toLowerCase())
        )
        .map((g: any) => g.id)
    )

    const currentGroupIds = await this.getUserGroupIds(user.id)
    const currentSet = new Set(currentGroupIds)

    const toAdd = [...matchedGroupIds].filter((id) => !currentSet.has(id))
    const toRemove = currentGroupIds.filter(
      (id) => !matchedGroupIds.has(id) && !protectedFromRemoval.has(id)
    )

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
   * still pending cannot be used to overwrite whatever password it was originally set up with. A
   * verified account, or one on a strategy with `emailValidation` off, always refuses as a duplicate.
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

    if (!strategy.registration) {
      WIKI.models.flags.authDebug(
        `Registration refused: strategy ${strategy.id} does not accept new users`
      )
      throw new Error('ERR_REGISTRATION_DISABLED')
    }

    const normalizedEmail = email.toLowerCase().trim()
    const requiresVerification = Boolean(strategy.config?.emailValidation)
    const existing = await this.getByEmail(normalizedEmail)

    if (existing) {
      if (existing.isVerified || !requiresVerification) {
        throw new Error('ERR_EMAIL_ALREADY_EXISTS')
      }
      WIKI.models.flags.authDebug(
        `Registration for <${normalizedEmail}> matched an unverified account, resending the verification email`
      )
      const token = await this.generateToken({ kind: 'verify', userId: existing.id })
      await WIKI.models.mail.sendVerifyEmail({ to: existing.email, name: existing.name, token })
      return { nextAction: 'verify' }
    }

    if (strategy.allowedEmailRegex) {
      let allowed = false
      try {
        allowed = new RegExp(strategy.allowedEmailRegex).test(normalizedEmail)
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

    const userId = await this.createUser({
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
      const token = await this.generateToken({ kind: 'verify', userId })
      await WIKI.models.mail.sendVerifyEmail({ to: normalizedEmail, name, token })
      return { nextAction: 'verify' }
    }

    const user = await this.getById(userId)
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
      if (authStr.tfaIsActive && authStr.tfaSecret) {
        try {
          const tfaToken = await this.generateToken({
            kind: 'tfa',
            userId: user.id,
            meta: {
              strategyId
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
          const { tfaQRImage } = await this.startTfaSetup(user, strategyId, context.siteId)
          const tfaToken = await this.generateToken({
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
        const pwdChangeToken = await this.generateToken({
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
    this.updateSession(user, req)

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

    const { user, strategyId: expectedStrategyId } = await this.validateToken({
      kind: setup ? 'tfaSetup' : 'tfa',
      token: continuationToken,
      skipDelete: true
    })
    if (!user) {
      throw new Error('ERR_INVALID_USER')
    }
    if (strategyId !== expectedStrategyId) {
      throw new Error('ERR_INVALID_STRATEGY')
    }

    let verified: boolean
    if (isTotpShape) {
      verified = this.verifyTfaCode(user, strategyId, securityCode)
    } else {
      const auth = (user.auth ?? {}) as Record<string, any>
      const entries = (auth[strategyId]?.recoveryCodes ?? []) as RecoveryCodeEntry[]
      // -> Distinguished from a plain wrong code: the client's response to "you mistyped it" and
      //    "you have nothing left to try" should not be the same generic rejection.
      if (entries.every((entry) => entry.usedAt)) {
        throw new Error('ERR_TFA_RECOVERY_CODES_EXHAUSTED')
      }
      verified = await this.verifyAndConsumeRecoveryCode(user, strategyId, securityCode)
    }
    if (!verified) {
      await countTfaFailure(continuationToken)
      WIKI.models.flags.authDebug(`User ${user.id} <${user.email}> submitted an incorrect 2FA code`)
      throw new Error('ERR_TFA_INCORRECT_TOKEN')
    }

    await this.destroyToken({ token: continuationToken })
    let recoveryCodes: string[] | undefined
    if (setup) {
      recoveryCodes = await this.enableTfa(user, strategyId)
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
    const user = await this.getById(userId)
    if (!user) {
      throw new Error('ERR_INVALID_USER')
    }
    const auth = (user.auth ?? {}) as Record<string, any>
    if (!auth[strategyId]) {
      throw new Error('ERR_INVALID_STRATEGY')
    }
    // -> Replacing a working secret would silently invalidate the app entry the user already has;
    //    turning 2FA off first is the way to start again
    if (auth[strategyId].tfaIsActive) {
      throw new Error('ERR_TFA_ALREADY_ACTIVE')
    }

    const { secret, tfaQRImage } = await this.startTfaSetup(user, strategyId, siteId)
    const continuationToken = await this.generateToken({
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

    const { user, strategyId: expectedStrategyId } = await this.validateToken({
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
    if (!this.verifyTfaCode(user, strategyId, securityCode)) {
      await countTfaFailure(continuationToken)
      throw new Error('ERR_TFA_INCORRECT_TOKEN')
    }

    await this.destroyToken({ token: continuationToken })
    const recoveryCodes = await this.enableTfa(user, strategyId)
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
    const { user, strategyId: expectedStrategyId } = await this.validateToken({
      kind: 'changePwd',
      token: continuationToken
    })

    if (strategyId !== expectedStrategyId) {
      throw new Error('ERR_INVALID_STRATEGY')
    }

    if (user) {
      user.auth[strategyId].password = await bcrypt.hash(newPassword, 12)
      user.auth[strategyId].mustChangePwd = false
      await WIKI.db.update(usersTable).set({ auth: user.auth }).where(eq(usersTable.id, user.id))

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
   * with `allowForgotPassword` off, an email matching no account, and an account that has no password
   * under this strategy (e.g. provider-only) are all silently a no-op. `api/authentication.ts`'s route
   * answers the same generic success either way, which is what actually closes the
   * email-enumeration hole -- this method just makes sure there is nothing here (a thrown `ERR_`, a
   * different return shape) for that route to leak by accident.
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

    const user = await this.getByEmail(email.toLowerCase().trim())
    const auth = (user?.auth ?? {}) as Record<string, any>
    if (!user || !auth[strategyId]?.password) {
      WIKI.models.flags.authDebug(
        `Forgot-password request for an address with no matching local account under strategy ${strategyId}`
      )
      return
    }

    const token = await this.generateToken({
      kind: 'resetPwd',
      userId: user.id,
      meta: { strategyId }
    })
    await WIKI.models.mail.sendForgotPassword({ to: user.email, name: user.name, token })
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
    const { user, strategyId: expectedStrategyId } = await this.validateToken({
      kind: 'resetPwd',
      token
    })

    if (strategyId !== expectedStrategyId) {
      throw new Error('ERR_INVALID_STRATEGY')
    }
    if (!user || !user.auth?.[strategyId]) {
      throw new Error('ERR_INVALID_USER')
    }

    user.auth[strategyId].password = await bcrypt.hash(newPassword, 12)
    user.auth[strategyId].mustChangePwd = false
    await WIKI.db.update(usersTable).set({ auth: user.auth }).where(eq(usersTable.id, user.id))

    try {
      await WIKI.models.mail.sendPasswordResetConfirmed({ to: user.email, name: user.name })
    } catch (err: any) {
      // -> The password change already succeeded; a failed notice email must not turn this into a
      //    failed reset
      WIKI.logger.warn(
        `Failed to send the password-reset-confirmed notice to ${user.email}: ${err.message}`
      )
    }

    return this.afterLoginChecks(user, strategyId, { ip, siteId }, { skipChangePwd: true }, req)
  }

  updateSession(user: any, req: any): void {
    req.session.authenticated = true
    req.session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      hasAvatar: user.hasAvatar,
      timezone: user.prefs?.timezone,
      dateFormat: user.prefs?.dateFormat,
      timeFormat: user.prefs?.timeFormat,
      appearance: user.prefs?.appearance,
      cvd: user.prefs?.cvd
    }
    req.session.permissions = uniq(flatten(user.groups?.map((g: any) => g.permissions)))
    // -> Group ids as well as their permissions, since navigation items are limited per group
    req.session.groups = (user.groups ?? []).map((g: any) => g.id)
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
}

export const users = new Users()
