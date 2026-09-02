import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import QRCode from 'qrcode'
import {
  assets as assetsTable,
  authentication as authenticationTable,
  groups as groupsTable,
  pageEditSubmissions,
  pages as pagesTable,
  sessions as sessionsTable,
  userAvatars,
  userGroups,
  users as usersTable,
  userKeys
} from '../db/schema.ts'
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  lt,
  notExists,
  or,
  sql
} from 'drizzle-orm'
import type { WikiDbOrTx } from '../core/db.ts'
import { nanoid } from 'nanoid'
import { flatten, uniq } from 'es-toolkit/array'
import { BCRYPT_ROUNDS, escapeLikePattern, isUniqueViolation } from '../helpers/common.ts'
import { detectImageMime, resizeImageToSquareJpeg } from '../helpers/images.ts'
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from '../helpers/totp.ts'
import { AccountRateLimitedError, consumeAccountAuthAttempt } from '../helpers/rateLimit.ts'
import { withAdvisoryLock } from '../helpers/advisoryLock.ts'
import { paginate } from '../helpers/pagination.ts'
import {
  generateRecoveryCodes,
  isRecoveryCodeShape,
  normalizeRecoveryCode
} from '../helpers/recoveryCodes.ts'
import { ProvisionableLoginError } from './authentication.ts'
import type { AuthStrategy, ProviderProfile } from './authentication.ts'
import type { SystemIds } from './types.ts'

/** The essential user fields, mirroring the `UserCore` API schema. */
export type UserCore = Pick<
  typeof usersTable.$inferSelect,
  | 'id'
  | 'name'
  | 'email'
  | 'hasAvatar'
  | 'isSystem'
  | 'isActive'
  | 'isVerified'
  | 'createdAt'
  | 'updatedAt'
  | 'lastLoginAt'
>

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
  locale: string
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
  locale?: string
}

/** The `meta` keys the profile owns, and the `prefs` keys it owns. */
const profileMetaKeys = ['location', 'jobTitle', 'pronouns'] as const
const profilePrefsKeys = [
  'timezone',
  'dateFormat',
  'timeFormat',
  'appearance',
  'cvd',
  'locale'
] as const

/**
 * The square, in pixels, an avatar is resized to. The profile page and the account menu both display
 * one at 180px; nothing displays one larger.
 */
const avatarSize = 180

/**
 * One local-provider user row, as an insert value.
 *
 * The same literal — a six-key local auth entry, the three `meta` fields, the five `prefs` fields —
 * was written out three times: `createUser()`, `importLocalUser()` and `init()`'s seeded
 * administrator. They cannot call each other (`importLocalUser`'s doc comment explains why reusing
 * `createUser` would double-hash an already-hashed password, and `init` runs before
 * `WIKI.data.systemIds` exists), but they can share the shape they all write.
 *
 * `meta`/`prefs` fall back through the caller's value, then the instance-wide user defaults an
 * administrator can change, then a literal — the chain `createUser` and `importLocalUser` already
 * used, and the values `base.yml` seeds those defaults with, which is what `init()` wrote by hand.
 * `createdAt`/`updatedAt`/`lastLoginAt` left undefined are omitted by drizzle, so the columns take
 * their own defaults rather than being written as a literal.
 */
function localUserRow(input: {
  id?: string
  strategyId: string
  email: string
  name: string
  /** Already hashed — nothing here calls `bcrypt.hash()`; every caller hashes (or carries) its own. */
  passwordHash: string
  mustChangePassword: boolean
  isActive: boolean
  isVerified: boolean
  meta?: { location?: string; jobTitle?: string; pronouns?: string }
  prefs?: {
    timezone?: string
    dateFormat?: string
    timeFormat?: string
    appearance?: string
    cvd?: string
  }
  createdAt?: Date
  updatedAt?: Date
  lastLoginAt?: Date
}): typeof usersTable.$inferInsert {
  const meta = input.meta ?? {}
  const prefs = input.prefs ?? {}
  return {
    id: input.id,
    email: input.email.toLowerCase(),
    name: input.name,
    auth: {
      [input.strategyId]: {
        password: input.passwordHash,
        mustChangePwd: input.mustChangePassword,
        restrictLogin: false,
        tfaIsActive: false,
        tfaRequired: false,
        tfaSecret: ''
      }
    },
    isSystem: false,
    isActive: input.isActive,
    isVerified: input.isVerified,
    meta: {
      location: meta.location ?? '',
      jobTitle: meta.jobTitle ?? '',
      pronouns: meta.pronouns ?? ''
    },
    prefs: {
      timezone: prefs.timezone ?? WIKI.config.userDefaults?.timezone ?? 'America/New_York',
      dateFormat: prefs.dateFormat ?? WIKI.config.userDefaults?.dateFormat ?? 'YYYY-MM-DD',
      timeFormat: prefs.timeFormat ?? WIKI.config.userDefaults?.timeFormat ?? '12h',
      appearance: prefs.appearance ?? 'site',
      cvd: prefs.cvd ?? 'none'
    },
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    lastLoginAt: input.lastLoginAt
  }
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
 * Selection shared by the list / detail queries. Never includes `auth` or `passkeys`.
 *
 * Exported for `models/groups.ts#getGroupUsers`, which pages the same ten columns off a join onto
 * this table — it had them written out a second time, which is exactly the kind of copy that drifts
 * the day a column is added to one list and not the other.
 */
export const userSelection = {
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

  async getById(id: string, db: WikiDbOrTx = WIKI.db) {
    const res = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1)
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

    const { total, rows } = await paginate({
      rows: () =>
        WIKI.db
          .select(userSelection)
          .from(usersTable)
          .where(where)
          .orderBy(usersTable.name)
          .limit(limit)
          .offset((page - 1) * limit),
      total: () => WIKI.db.select({ total: count() }).from(usersTable).where(where)
    })

    return { total, users: rows }
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
    const auth = await this.describeLinkedProviders(user)

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
    // -> Hashed before the transaction opens rather than inside it: bcrypt is CPU-bound, not a query,
    //    and there is no reason to hold the checked-out connection idle while it runs.
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

    // -> The insert and its group assignment must land together or not at all (OpenProject #1607): a
    //    `setUserGroups` failure after the insert had already committed used to leave a user row with
    //    no memberships behind a 500, and the administrator's retry hit the email-uniqueness conflict
    //    instead of anything informative.
    const userId = await WIKI.db.transaction(async (tx) => {
      const result = await tx
        .insert(usersTable)
        // -> `meta`/`prefs` left to `localUserRow`, which seeds them from the instance-wide user
        //    defaults an administrator can change
        .values(
          localUserRow({
            strategyId: localStrategyId,
            email,
            name,
            passwordHash,
            mustChangePassword,
            isActive: true,
            isVerified
          })
        )
        .returning({ id: usersTable.id })

      const newUserId = result[0].id
      if (groups.length > 0) {
        await this.setUserGroups(newUserId, groups, tx)
      }
      return newUserId
    })

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
   * `createUser()` calls `bcrypt.hash(password, BCRYPT_ROUNDS)` on whatever string it receives. A 2.5.x
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
   * ## Carried-over state — explicit decision: read from the source, never assumed (Task 1847)
   * `isActive`, `meta` (`location`/`jobTitle`/`pronouns`), `prefs`
   * (`timezone`/`dateFormat`/`timeFormat`/`appearance`/`cvd`) and the three timestamps
   * (`createdAt`/`updatedAt`/`lastLoginAt`) all have a `docs/migration/2.5x-to-3.0-mapping.md`
   * "direct" mapping and are accepted as parameters here rather than hardcoded. `isActive` in
   * particular defaults to `false` (matching the column's own default) rather than `true` when the
   * caller omits it: a 2.x account an administrator deliberately deactivated must not be silently
   * recreated as active. `meta`/`prefs` are merged field-by-field over the pre-existing defaults
   * (including `WIKI.config.userDefaults`) so a caller — or the existing test suite — that omits
   * some or all of them keeps the prior behavior. The three timestamps are left `undefined` when not
   * given, which drizzle resolves to each column's own default (`defaultNow()` for
   * `createdAt`/`updatedAt`, `NULL` for `lastLoginAt`) rather than inserting a literal `NULL`/`now()`
   * value here.
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
    isVerified = true,
    isActive = false,
    meta = {},
    prefs = {},
    createdAt,
    updatedAt,
    lastLoginAt
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
    /** Whether the source account was active. Always read from the source — see this method's doc.
     * Defaults to `false` (never `true`) when the caller has no source value to give. */
    isActive?: boolean
    meta?: { location?: string; jobTitle?: string; pronouns?: string }
    prefs?: {
      timezone?: string
      dateFormat?: string
      timeFormat?: string
      appearance?: string
      cvd?: string
    }
    /** Source `createdAt`/`updatedAt`/`lastLoginAt`, carried over verbatim so an imported account's
     * "member since" reflects the source install, not the import date. Omitted fields fall back to
     * the column's own default rather than being written as a literal value. */
    createdAt?: Date
    updatedAt?: Date
    lastLoginAt?: Date
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
        .values(
          localUserRow({
            strategyId: localStrategyId,
            email: normalizedEmail,
            name,
            passwordHash,
            mustChangePassword,
            isActive,
            isVerified,
            meta,
            prefs,
            createdAt,
            updatedAt,
            lastLoginAt
          })
        )
        .returning({ id: usersTable.id })
    } catch (err: any) {
      // -> See the collision-policy note above: a race between the pre-check and this insert still
      //    surfaces as the same skip result, not a generic thrown failure.
      if (isUniqueViolation(err)) {
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
  async updateUser(id: string, patch: UserPatch, db: WikiDbOrTx = WIKI.db): Promise<boolean> {
    const values: Record<string, any> = { ...patch, updatedAt: sql`now()` }
    if (typeof values.email === 'string') {
      values.email = values.email.toLowerCase()
    }
    const result = await db.update(usersTable).set(values).where(eq(usersTable.id, id))
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
      cvd: prefs.cvd ?? 'none',
      // -> An empty locale means "no preference recorded" — mail resolves such a user's messages in
      //    `en`, the same fallback `models/locales.ts#resolveString`'s server-side string resolver
      //    uses for an unset or unknown locale.
      locale: prefs.locale ?? ''
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
   * @throws `ERR_INVALID_LOCALE` for a non-empty `locale` that names no installed locale
   */
  async updateProfile(id: string, patch: UserProfilePatch): Promise<UserProfile | null> {
    const user = await this.getById(id)
    if (!user) {
      return null
    }

    // -> Validated against the installed catalogue rather than a static enum, same reasoning as the
    //    timezone check in `api/users.ts` — the valid set is only known at runtime. An empty string
    //    clears the preference (falls back to `en` when mail resolves it), so it skips the check.
    if (patch.locale !== undefined && patch.locale !== '') {
      const known = (await WIKI.models.locales.getLocales()).some(
        (lc: any) => lc.code === patch.locale
      )
      if (!known) {
        throw new Error('ERR_INVALID_LOCALE')
      }
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
   * The sha1 hash of a user's avatar, without reading the blob itself — selects only the `hash`
   * column, kept in step with `data` by every write in `setAvatar`. Lets a conditional request
   * (ETag) be answered without pulling the avatar back out of the database.
   *
   * @returns The hash, or null if this user has no avatar
   */
  async getAvatarHash(userId: string): Promise<string | null> {
    const rows = await WIKI.db
      .select({ hash: userAvatars.hash })
      .from(userAvatars)
      .where(eq(userAvatars.id, userId))
      .limit(1)
    return rows[0]?.hash ?? null
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
    // -> Kept in step with `data` on every write -- `hash` is NOT NULL with no default, and this is
    //    the same sha1-hex digest `controllers/user.ts` computes from the blob for its ETag, so a
    //    future hash-only reader agrees with what a full blob read would have produced.
    const hash = crypto.createHash('sha1').update(normalized).digest('hex')
    await WIKI.db
      .insert(userAvatars)
      .values({ id: userId, data: normalized, hash })
      .onConflictDoUpdate({ target: userAvatars.id, set: { data: normalized, hash } })
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
   * The groups a user does NOT belong to, by name. Only the identity of each group — same shape as
   * `getUserGroups()` — for the profile page's admin-gated "other groups" section; never member count
   * or any other metadata.
   */
  async getNonMemberGroups(userId: string): Promise<Array<{ id: string; name: string }>> {
    return WIKI.db
      .select({ id: groupsTable.id, name: groupsTable.name })
      .from(groupsTable)
      .where(
        notExists(
          WIKI.db
            .select({ exists: sql`1` })
            .from(userGroups)
            .where(and(eq(userGroups.groupId, groupsTable.id), eq(userGroups.userId, userId)))
        )
      )
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
   *
   * @param db The ambient `WIKI.db`, or a transaction handle to join — e.g. `createUser()` passes its
   * own open transaction so the membership rows commit (or roll back) atomically with the user row.
   */
  async setUserGroups(userId: string, groupIds: string[], db: WikiDbOrTx = WIKI.db): Promise<void> {
    const user = await this.getById(userId, db)
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
        ? await db
            .select({ id: groupsTable.id })
            .from(groupsTable)
            .where(inArray(groupsTable.id, allowed))
        : []
    const wantedIds = wanted.map((g: any) => g.id)

    // -> One transaction: `userGroups` has no soft-replace path, so a plain delete-then-insert left a
    //    window where a concurrent single-membership grant landing in between could make the insert's
    //    conflict on the composite primary key fail outright, or a dropped connection could leave the
    //    user in no groups at all -- no admin access, no page rules -- with the caller's error saying
    //    nothing about membership having been wiped. `reassignContent` above draws this same boundary.
    //    Transacting on `db` (not the ambient `WIKI.db`) is what lets `createUser()`'s own open
    //    transaction be joined rather than raced by a second, independent one -- drizzle nests it as a
    //    savepoint when `db` is already a transaction handle.
    await db.transaction(async (tx) => {
      await tx.delete(userGroups).where(eq(userGroups.userId, userId))
      if (wantedIds.length > 0) {
        await tx
          .insert(userGroups)
          .values(wantedIds.map((groupId: string) => ({ userId, groupId })))
      }
    })
  }

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
  private async patchStrategyAuth(
    userId: string,
    strategyId: string,
    mutate: (
      entry: Record<string, any> | undefined
    ) => Record<string, any> | null | Promise<Record<string, any> | null>,
    opts: { db?: WikiDbOrTx; mirrorInto?: { auth: unknown } } = {}
  ): Promise<boolean> {
    const db = opts.db ?? WIKI.db
    return withAdvisoryLock(authLockKey(userId), async () => {
      const current = await this.getById(userId, db)
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
  private async requireStrategyAuth(
    userId: string,
    strategyId: string,
    opts: { tfaActive?: boolean } = {}
  ): Promise<{ user: any; auth: Record<string, any>; entry: Record<string, any> }> {
    const user = await this.getById(userId)
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
   * Apply a profile patch, group membership, and/or local auth-flag changes to a user in one
   * transaction, clearing that user's sessions when required — the atomic replacement for
   * `PUT /users/:userId`'s previously separate calls to `updateUser`, `setUserGroups`,
   * `setUserAuthFlags` and `sessions.clearSessionsFromUser` (OpenProject #1609). A failure partway
   * through no longer leaves an earlier write in this sequence committed behind a 500.
   *
   * The route keeps its pre-flight guards (duplicate email, system-user protection, `manage:system`
   * escalation, last-root-admin) outside this method, and still calls `auditLog.record()` itself
   * afterwards — that call cannot throw (`models/auditLog.ts`) and carries `patch`/`groups`/`auth` as
   * it was asked for, not as this method interpreted it, so it has no reason to join the transaction.
   *
   * @param id The user being updated
   * @param patch Profile fields to change; omitted or empty skips the profile write entirely
   * @param groups The new group membership; `undefined` leaves membership unchanged
   * @param authFlags Local-strategy flags to set; `undefined` leaves them unchanged
   */
  async applyUserUpdate(
    id: string,
    {
      patch,
      groups,
      authFlags
    }: {
      patch?: UserPatch
      groups?: string[]
      authFlags?: Record<string, any>
    }
  ): Promise<void> {
    await WIKI.db.transaction(async (tx) => {
      if (patch && Object.keys(patch).length > 0) {
        await this.updateUser(id, patch, tx)
      }
      if (groups !== undefined) {
        await this.setUserGroups(id, groups, tx)
      }
      if (authFlags !== undefined) {
        await this.setUserAuthFlags(id, authFlags, tx)
      }
      // -> Mirrors the route's original condition: a deactivation or a membership change must end any
      //    open session now, the same way `models/sessions.ts#clearSessionsFromUser` documents.
      if (patch?.isActive === false || groups !== undefined) {
        await WIKI.models.sessions.clearSessionsFromUser(id, tx)
      }
      // -> OpenProject #2094: a `resetPwd` (or other) token minted before deactivation would
      //    otherwise still be redeemable afterwards -- `afterLoginChecks()` refuses the login it
      //    would end in, but not before `resetPassword()` has already rewritten the password hash.
      //    See `clearKeysFromUser`'s own doc comment.
      if (patch?.isActive === false) {
        await this.clearKeysFromUser(id, tx)
      }
    })
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
    const user = await this.getById(userId)
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
  private async describeLinkedProviders(
    user: any,
    opts: { forProfile: true }
  ): Promise<UserProfileAuthMethod[]>
  private async describeLinkedProviders(
    user: any,
    opts?: { forProfile?: false }
  ): Promise<UserAuthProvider[]>
  private async describeLinkedProviders(
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
   * Bulk-reassign every page and asset `fromUserId` authored to `toUserId`, in one transaction.
   *
   * `pages.authorId`/`creatorId`/`ownerId` and `assets.authorId` are reassigned here, but they are
   * NOT the only columns referencing `users.id` with no `onDelete` cascade or `set null` (see
   * `db/schema.ts`) -- `pageEditSubmissions.authorId` has no `onDelete` either, and blocks
   * `deleteUser()`'s foreign key check exactly the same way. This method does not touch it: an open
   * page edit suggestion has no "reassign" remedy, only approve/reject (`models/approvals.ts`), so
   * clearing it is a different operation, not a fourth column added to the two `UPDATE`s below.
   * Reassigning what this method DOES cover clears deleteUser()'s foreign key violation for a user
   * who authored, created, or owns any page, or authored any asset -- it does not by itself clear an
   * open page edit suggestion still naming them as author.
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
   * Group assignments cascade, but sessions, keys and the avatar do not — they are login/profile
   * artifacts, so they are cleared here rather than blocking the delete. Open edit submissions
   * (`pageEditSubmissions.authorId`) are discarded here too rather than nulled: the column is
   * nullable and could survive as an anonymous suggestion, but that would silently change what the
   * submission is instead of removing what belonged to the deleted account. References from
   * authored content (pages, assets) have no cascade either and will make this throw, which is
   * deliberate: the delete is refused rather than silently orphaning content.
   *
   * Everything runs in one transaction so a delete refused by that foreign-key conflict leaves the
   * user's sessions, keys and avatar intact rather than having already destroyed them.
   *
   * @returns Whether a user was deleted
   */
  async deleteUser(id: string): Promise<boolean> {
    return WIKI.db.transaction(async (tx) => {
      await tx.delete(userKeys).where(eq(userKeys.userId, id))
      await tx.delete(sessionsTable).where(eq(sessionsTable.userId, id))
      await tx.delete(userAvatars).where(eq(userAvatars.id, id))
      await tx.delete(pageEditSubmissions).where(eq(pageEditSubmissions.authorId, id))
      const result = await tx.delete(usersTable).where(eq(usersTable.id, id))
      return (result.rowCount ?? 0) > 0
    })
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

  async init(ids: SystemIds): Promise<void> {
    WIKI.logger.info('Inserting default users...')

    await WIKI.db.insert(usersTable).values([
      localUserRow({
        id: ids.userAdminId,
        // -> `WIKI.data.systemIds` is not populated yet at seeding time, so the local strategy's id
        //    comes from the ids being seeded rather than from that global
        strategyId: ids.authModuleId,
        email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
        name: 'Administrator',
        passwordHash: await bcrypt.hash(process.env.ADMIN_PASS || '12345678', BCRYPT_ROUNDS),
        mustChangePassword: !process.env.ADMIN_PASS,
        isActive: true,
        isVerified: true
      }),
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
   * @throws `ERR_REGISTRATION_DISABLED`, `ERR_EMAIL_NOT_ALLOWED`, `ERR_ACCOUNT_NOT_LINKED`,
   *         `ERR_LOGIN_FAILED`
   */
  private async findOrCreateProviderUser(
    strategy: AuthStrategy,
    profile: ProviderProfile
  ): Promise<any> {
    const email = profile.email.toLowerCase().trim()
    let user = await this.getByEmail(email)

    // -> Checked before anything else: a system account (the seeded Guest row) must never be reachable
    //    through a provider, linked or not -- getByEmail() has no isSystem filter, unlike its siblings.
    if (user?.isSystem) {
      WIKI.models.flags.authDebug(
        `Provider login for <${email}> refused: address belongs to a system account`
      )
      throw new Error('ERR_LOGIN_FAILED')
    }

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

    /*
      The link between this account and the provider's, written on every login: it records which
      account at the provider this is, and it is what tells the profile page that this user signs in
      through this strategy.
    */
    await this.patchStrategyAuth(user.id, strategy.id, () => ({ id: profile.id, email }), {
      mirrorInto: user
    })

    // -> Every login, not only the one that created the account: a group added or removed at the
    //    provider since the last login has to show up here too.
    if (strategy.config?.mapGroups && profile.groups) {
      await this.syncProviderGroups(user, strategy, profile.groups)
    }

    return user
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
   *     wiki-level administrative access, mirroring the same invariant `api/users.ts` enforces for a
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

    const protectedFromRemoval = new Set([
      guestsGroupId,
      ...(strategy.autoEnrollGroups ?? []),
      ...neverMapped
    ])

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

    const currentGroupIds = await this.getUserGroupIds(user.id)
    const currentSet = new Set(currentGroupIds)

    const toAdd = [...matchedGroupIds].filter((id) => !currentSet.has(id))
    // -> Only an allow-listed group can ever be revoked: a group the sync could not have granted
    //    (never mapped, or simply absent from the strategy's own allow-list) must not be granted OR
    //    removed, so `mappable.has(id)` gates removal the same way it gates the grant above.
    const toRemove = currentGroupIds.filter(
      (id) => mappable.has(id) && !matchedGroupIds.has(id) && !protectedFromRemoval.has(id)
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
    const requiresVerification = Boolean(strategy.config?.emailValidation)
    const existing = await this.getByEmail(normalizedEmail)

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
        const token = await this.generateToken({ kind: 'verify', userId: existing.id })
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
          const tfaToken = await this.generateToken({
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
    await this.updateSession(user, req)

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
    } = await this.validateToken({
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
      verified = await this.verifyTfaCode(user, verifyStrategyId, securityCode)
    } else {
      const auth = (user.auth ?? {}) as Record<string, any>
      const entries = (auth[verifyStrategyId]?.recoveryCodes ?? []) as RecoveryCodeEntry[]
      // -> Distinguished from a plain wrong code: the client's response to "you mistyped it" and
      //    "you have nothing left to try" should not be the same generic rejection.
      if (entries.every((entry) => entry.usedAt)) {
        throw new Error('ERR_TFA_RECOVERY_CODES_EXHAUSTED')
      }
      verified = await this.verifyAndConsumeRecoveryCode(user, verifyStrategyId, securityCode)
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
    const { user, entry } = await this.requireStrategyAuth(userId, strategyId)
    // -> Replacing a working secret would silently invalidate the app entry the user already has;
    //    turning 2FA off first is the way to start again
    if (entry.tfaIsActive) {
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
    if (!(await this.verifyTfaCode(user, strategyId, securityCode))) {
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
      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
      await this.patchStrategyAuth(
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
   * been restricted (`restrictLogin`) are all silently a no-op. `api/authentication.ts`'s route
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

    const user = await this.getByEmail(email.toLowerCase().trim())
    const auth = (user?.auth ?? {}) as Record<string, any>
    if (!user || !auth[strategyId]?.password || !user.isActive || auth[strategyId].restrictLogin) {
      WIKI.models.flags.authDebug(
        `Forgot-password request for an address with no matching, resettable local account under strategy ${strategyId}`
      )
      return
    }

    const token = await this.generateToken({
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

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    await this.patchStrategyAuth(
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

  /**
   * Mark a session authenticated for `user` — the one place every login path (local, provider,
   * passkey, and the 2FA / password-change continuations) ends up, via `afterLoginChecks`.
   *
   * Regenerates the session id first (task 2115 / WP 2105 §4, session fixation): without this, an
   * attacker who can plant a session id on a victim before they log in — `saveUninitialized: false`
   * does not prevent it, since two public pre-login endpoints already force a store write and a
   * `Set-Cookie` (`POST /sites/:siteId/auth/passkey/challenge` and `GET /auth/:strategyId/authorize`
   * in `api/authentication.ts`) — ends up sharing the victim's now-authenticated session once they
   * do. `@fastify/session#regenerate()` mints a fresh session id and store row and reassigns it onto
   * `req.session` in place, so every read of `req.session` after this line — in this method, and
   * back up the call chain in `afterLoginChecks` — already sees the regenerated one. Nothing needs
   * carrying across: the only things a pre-login session ever holds (`authFlow`, `passkeyLogin`) are
   * already cleared by their own callers once the ceremony they were for finishes.
   */
  async updateSession(user: any, req: any): Promise<void> {
    await req.session.regenerate()

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
      cvd: user.prefs?.cvd,
      locale: user.prefs?.locale
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

export const users = new Users()
