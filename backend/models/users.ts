import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import {
  assets as assetsTable,
  groups as groupsTable,
  pageEditSubmissions,
  pages as pagesTable,
  sessions as sessionsTable,
  userAvatars,
  userGroups,
  users as usersTable,
  userKeys
} from '../db/schema.ts'
import { and, count, desc, eq, ilike, inArray, isNotNull, notExists, or, sql } from 'drizzle-orm'
import type { WikiDbOrTx } from '../core/db.ts'
import { flatten, uniq } from 'es-toolkit/array'
import { BCRYPT_ROUNDS, escapeLikePattern, isUniqueViolation } from '../helpers/common.ts'
import { detectImageMime, resizeImageToSquareJpeg } from '../helpers/images.ts'
import { paginate } from '../helpers/pagination.ts'
import { HOOK_EVENTS, type HookEvent } from './hooks.ts'
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
 * A migrated provider-fallback account still waiting on its password reset — all
 * `getFallbackAccounts()` discloses. `providerKey` is the original 2.x `providerKey` verbatim
 * (`'google'`, `'ldap'`, a legacy CAS key, …), preserved by
 * `migration/importers/users-groups.ts#createProviderFallbackUserConverter` purely for this kind of
 * admin visibility — see that function's doc comment.
 */
export interface FallbackAccount {
  id: string
  name: string
  email: string
  providerKey: string
  createdAt: Date
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

/**
 * One boolean per event type a user may opt into receiving an email for (Feature #2425). Keyed by
 * {@link HookEvent} rather than a separate vocabulary, since `#2481` (extending webhook dispatch to
 * also emit email) fires against exactly this same event list -- a subscriber map with its own set
 * of names would need translating between the two at delivery time for no benefit.
 */
export type NotificationSubscriptions = Record<HookEvent, boolean>

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
   * Fetch every migrated provider-fallback account that has not yet relinked via SSO — the report
   * `docs/migration/migration-runbook.md`'s Step 3 used to send an administrator to run by hand
   * directly against Postgres.
   *
   * Gated on the SAME two conditions `models/login.ts#clearMigratedFallbackLocalAuth` clears
   * together: the local-strategy auth entry's `mustChangePwd` AND `migratedFallbackProvider` both
   * present. `mustChangePwd` alone would also catch a genuine local account an administrator forced
   * a password reset on; `migratedFallbackProvider` alone cannot occur without `mustChangePwd` (only
   * `createProviderFallbackUserConverter` ever writes it, always alongside `mustChangePwd: true`),
   * but requiring both keeps this query's intent legible on its own without relying on that
   * invariant holding forever.
   *
   * Reads `auth` by its JSONB path directly rather than through `describeLinkedProviders()`
   * (`getUserDetail()`'s helper): that reshapes the CURRENT session's provider list for a single
   * user, and has no "which users" filter to give it — this is the reverse question, asked across
   * every account at once.
   *
   * @returns Every pending fallback account, oldest-created first (the accounts that have been
   *   waiting on a reset the longest surface first)
   */
  async getFallbackAccounts(): Promise<FallbackAccount[]> {
    const localStrategyId = WIKI.data.systemIds.localAuthId
    const providerKeyExpr = sql<string>`(${usersTable.auth} -> ${localStrategyId} ->> 'migratedFallbackProvider')`

    return WIKI.db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        createdAt: usersTable.createdAt,
        providerKey: providerKeyExpr
      })
      .from(usersTable)
      .where(
        sql`(${usersTable.auth} -> ${localStrategyId} ->> 'mustChangePwd')::boolean = true AND ${providerKeyExpr} IS NOT NULL`
      )
      .orderBy(usersTable.createdAt)
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
    const auth = await WIKI.models.userCredentials.describeLinkedProviders(user)

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
   * Which `HookEvent`s this user asked to be emailed about — the storage half of the per-user,
   * per-event-type email notification toggle (`models/hooks.ts#Hooks.emit()` is the trigger half:
   * see its `notifyEmailSubscribers()`). Kept at `prefs.notifications.events`, the same
   * per-feature-blob-under-`prefs` shape `getEditorSettings`/`setEditorSettings` use for
   * `prefs.editors[editor]` — no migration needed to add or change it, and it costs nothing beyond
   * a jsonb read. Empty (opt-in, not opt-out) for a user who has never set a preference.
   *
   * OpenProject #2482 owns the settings UI this backs; the storage shape here is deliberately the
   * minimal thing `emit()`'s trigger extension needs to have something real to query, not a
   * finished preferences feature.
   *
   * @returns The subscribed events, or `[]` for a user who has none set or does not exist
   */
  async getEmailNotificationEvents(id: string): Promise<HookEvent[]> {
    const user = await this.getById(id)
    if (!user) {
      return []
    }
    const prefs = (user.prefs ?? {}) as Record<string, any>
    const stored = prefs.notifications?.events
    return Array.isArray(stored)
      ? stored.filter((event): event is HookEvent => HOOK_EVENTS.includes(event))
      : []
  }

  /**
   * Replace a user's set of subscribed event types, merging into `prefs` the same way
   * `setEditorSettings` merges into `prefs.editors` — every other preference (including a
   * different editor's own settings) survives untouched.
   *
   * Silently drops anything not in `HOOK_EVENTS`: this is a closed vocabulary (see
   * `models/hooks.ts`), not free text a caller can extend by typo.
   *
   * @returns The saved (filtered) list, or null if no such user exists
   */
  async setEmailNotificationEvents(id: string, events: string[]): Promise<HookEvent[] | null> {
    const user = await this.getById(id)
    if (!user) {
      return null
    }
    const filtered = events.filter((event): event is HookEvent =>
      HOOK_EVENTS.includes(event as HookEvent)
    )
    const prefs = { ...((user.prefs ?? {}) as Record<string, any>) }
    prefs.notifications = {
      ...((prefs.notifications ?? {}) as Record<string, any>),
      events: filtered
    }
    await this.updateUser(id, { prefs })
    return filtered
  }

  /**
   * Every active, non-system user subscribed to email notifications for one event type — the
   * subscriber half of `Hooks.emit()`'s email fan-out (see that method's `notifyEmailSubscribers()`).
   * Reads the same `prefs.notifications.events` array {@link setEmailNotificationEvents} writes, via
   * `jsonb_exists()` (the function form of jsonb's `?` containment operator, spelled out so it reads
   * unambiguously next to Drizzle's own `${}` parameter placeholders rather than risking the bare
   * operator being misread as one).
   *
   * Deliberately instance-wide, with no site or page-permission filtering: a webhook subscription
   * (what this mirrors) isn't scoped to what its owner can read either — see this feature's own
   * scope notes for why that's a known simplification here, not an oversight.
   */
  async listEmailSubscribers(event: HookEvent): Promise<{ id: string }[]> {
    return WIKI.db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.isActive, true),
          eq(usersTable.isSystem, false),
          sql`jsonb_exists(${usersTable.prefs} -> 'notifications' -> 'events', ${event})`
        )
      )
  }

  /**
   * A user's own per-event-type email notification subscriptions (Feature #2425), as the boolean
   * map the profile UI and `UserNotificationSubscriptions` schema deal in. A thin adapter over
   * {@link getEmailNotificationEvents} rather than a second storage location -- `#2481`'s
   * `Hooks.emit()` already reads that array (via {@link listEmailSubscribers}), so a competing
   * `prefs.eventSubscriptions` blob would leave this settings page changing something the trigger
   * side never looks at. Always returns a fully populated map over every {@link HOOK_EVENTS} entry
   * rather than only the events a user has actually subscribed to -- opting in is explicit, so an
   * event the user has never set, or one added to `HOOK_EVENTS` after they last saved, both default
   * to `false` here rather than being silently absent from the response.
   *
   * @returns The full subscription map, or null if no such user exists
   */
  async getNotificationSubscriptions(id: string): Promise<NotificationSubscriptions | null> {
    const user = await this.getById(id)
    if (!user) {
      return null
    }
    const subscribed = new Set(await this.getEmailNotificationEvents(id))
    const subscriptions = {} as NotificationSubscriptions
    for (const event of HOOK_EVENTS) {
      subscriptions[event] = subscribed.has(event)
    }
    return subscriptions
  }

  /**
   * Merge a patch into a user's per-event-type email notification subscriptions, translating the
   * boolean-map patch the route accepts into the subscribed-event array
   * {@link setEmailNotificationEvents} actually stores.
   *
   * Only the keys present in `patch` change; every other event type -- including one the caller
   * simply didn't send -- is left as it was. `patch` is trusted to carry only known
   * {@link HookEvent} keys: the route schema (`UserNotificationSubscriptionsUpdate`) is what
   * actually rejects an unknown one, so this only ever writes keys `HOOK_EVENTS` already lists.
   *
   * @returns The full, freshly merged subscription map, or null if no such user exists
   */
  async setNotificationSubscriptions(
    id: string,
    patch: Partial<NotificationSubscriptions>
  ): Promise<NotificationSubscriptions | null> {
    const user = await this.getById(id)
    if (!user) {
      return null
    }
    const existing = new Set(await this.getEmailNotificationEvents(id))
    for (const event of HOOK_EVENTS) {
      if (patch[event] === undefined) {
        continue
      }
      if (patch[event]) {
        existing.add(event)
      } else {
        existing.delete(event)
      }
    }
    const saved = await this.setEmailNotificationEvents(id, [...existing])
    if (!saved) {
      return null
    }
    const savedSet = new Set(saved)
    const subscriptions = {} as NotificationSubscriptions
    for (const event of HOOK_EVENTS) {
      subscriptions[event] = savedSet.has(event)
    }
    return subscriptions
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
    //    timezone check in `api/users/profile.ts` — the valid set is only known at runtime. An empty string
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
        await WIKI.models.userCredentials.setUserAuthFlags(id, authFlags, tx)
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
        await WIKI.models.userCredentials.clearKeysFromUser(id, tx)
      }
    })
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

  /**
   * Mark a session authenticated for `user` — the one place every login path (local, provider,
   * passkey, and the 2FA / password-change continuations) ends up, via `afterLoginChecks`.
   *
   * Regenerates the session id first (task 2115 / WP 2105 §4, session fixation): without this, an
   * attacker who can plant a session id on a victim before they log in — `saveUninitialized: false`
   * does not prevent it, since two public pre-login endpoints already force a store write and a
   * `Set-Cookie` (`POST /sites/:siteId/auth/passkey/challenge` and `GET /auth/:strategyId/authorize`
   * in `api/auth/site.ts`) — ends up sharing the victim's now-authenticated session once they
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
}

export const users = new Users()
