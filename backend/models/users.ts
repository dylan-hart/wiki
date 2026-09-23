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
import {
  BCRYPT_ROUNDS,
  CustomError,
  escapeLikePattern,
  isUniqueViolation
} from '../helpers/common.ts'
import { detectImageMime, resizeImageToSquareJpeg } from '../helpers/images.ts'
import { paginate } from '../helpers/pagination.ts'
import {
  isSearchFilters,
  normalizeSearchFilters,
  type SearchFilter
} from '../helpers/searchFilters.ts'
import { HOOK_EVENTS, type HookEvent } from './hooks.ts'
import type { SystemIds } from './types.ts'

/** Mirrors the `UserCore` API schema. */
export type UserCore = Pick<
  typeof usersTable.$inferSelect,
  | 'id'
  | 'name'
  | 'email'
  | 'hasAvatar'
  | 'avatarProviderUrl'
  | 'isSystem'
  | 'isActive'
  | 'isVerified'
  | 'createdAt'
  | 'updatedAt'
  | 'lastLoginAt'
>

/** `total` counts every user matching the filter, not the page size. */
export interface UserPage {
  total: number
  users: UserCore[]
}

export interface RecentLogin {
  id: string
  name: string
  email: string
  lastLoginAt: Date | null
}

/**
 * `providerKey` is the original 2.x `providerKey` verbatim (`'google'`, `'ldap'`, a legacy CAS key,
 * …), preserved by the users/groups importer purely for this kind of admin visibility.
 */
export interface FallbackAccount {
  id: string
  name: string
  email: string
  providerKey: string
  createdAt: Date
}

/**
 * `isSystem` is deliberately absent.
 *
 * `name`, `firstName`, `lastName` and `nameLocallyEdited` are interpreted rather than written
 * through verbatim — see {@link Users.updateUser}, the one place the derivation invariant lives.
 */
export interface UserPatch {
  name?: string
  firstName?: string
  lastName?: string
  /**
   * Normally left out: `updateUser()` maintains it. Set it explicitly only to override that — a
   * provider sign-in writing claim-sourced names passes `false` so filling an empty half does not
   * mark the account as locally authored.
   */
  nameLocallyEdited?: boolean
  handle?: string
  email?: string
  isActive?: boolean
  isVerified?: boolean
  meta?: Record<string, any>
  prefs?: Record<string, any>
}

/**
 * The knowledge graph view's persisted controls, stored verbatim under `prefs.graph`. Unlike the
 * flat string prefs, this one is saved and read back as one whole object -- `Graph.vue` merges every
 * control into a single PATCH whenever any of them change, so there is no per-key merge to do here:
 * absent from a patch leaves it untouched, present replaces it wholesale.
 */
export interface GraphPrefs {
  groupBy?: string
  sizeBy?: string
  count?: string
  over?: string
  clientTypes?: string[]
}

/** Stored verbatim under `prefs.iconPicker`, with the same treatment as {@link GraphPrefs}. */
export interface IconPickerPrefs {
  set?: string
}

export const PROFILE_PUBLIC_FIELDS = ['location', 'jobTitle', 'pronouns'] as const

export type ProfilePublicField = (typeof PROFILE_PUBLIC_FIELDS)[number]

/** Mirrors the `UserPublicProfile` API schema. */
export interface UserPublicProfile {
  id: string
  name: string
  hasAvatar: boolean
  avatarProviderUrl: string | null
  fields: Partial<Record<ProfilePublicField, string>>
}

/** The `meta` and `prefs` blobs flattened out; mirrors the `UserProfile` API schema. */
export interface UserProfile {
  id: string
  name: string
  firstName: string
  lastName: string
  email: string
  hasAvatar: boolean
  /** Only a fallback: an uploaded avatar (`hasAvatar`) wins whenever both are set. */
  avatarProviderUrl: string | null
  handle: string | null
  location: string
  jobTitle: string
  pronouns: string
  timezone: string
  dateFormat: string
  timeFormat: string
  appearance: string
  aesthetic: string
  /**
   * `'site'` inherits the site's own `contentWidth` admin setting; `'measured'`/`'full'` force this
   * reader's choice on every page, overriding it -- the same three-value site-default-with-override
   * shape `aesthetic` uses.
   */
  contentWidth: string
  cvd: string
  locale: string
  graph?: GraphPrefs
  iconPicker?: IconPickerPrefs
  publicFields: ProfilePublicField[]
  forcedPublicFields: ProfilePublicField[]
  searchFilters?: SearchFilter[]
}

/** What a user may change on its own profile: notably not the email, nor any admin flag. */
export interface UserProfilePatch {
  name?: string
  firstName?: string
  lastName?: string
  handle?: string
  location?: string
  jobTitle?: string
  pronouns?: string
  timezone?: string
  dateFormat?: string
  timeFormat?: string
  appearance?: string
  aesthetic?: string
  contentWidth?: string
  cvd?: string
  locale?: string
  graph?: GraphPrefs
  iconPicker?: IconPickerPrefs
  publicFields?: ProfilePublicField[]
  searchFilters?: SearchFilter[]
}

/**
 * Keyed by {@link HookEvent} rather than a vocabulary of its own: email dispatch fires against
 * exactly that event list, so a separate set of names would need translating at delivery time.
 */
export type NotificationSubscriptions = Record<HookEvent, boolean>

/**
 * Real columns, unlike the two `meta`/`prefs` lists below, and passed straight through to
 * {@link Users.updateUser} — the sole owner of the derive-unless-authored rule, and what decides
 * what `name` ends up being.
 */
const profileNameKeys = ['name', 'firstName', 'lastName'] as const

const profileMetaKeys = ['location', 'jobTitle', 'pronouns'] as const
const profilePrefsKeys = [
  'timezone',
  'dateFormat',
  'timeFormat',
  'appearance',
  'aesthetic',
  'contentWidth',
  'cvd',
  'locale',
  'graph',
  'iconPicker',
  'publicFields',
  'searchFilters'
] as const

export const HANDLE_MAX_LENGTH = 32

const HANDLE_PATTERN = /^[A-Za-z0-9._-]+$/

const HANDLE_UNIQUE_INDEX = 'users_handle_lower_idx'

export function normalizeHandle(input: string): string | null {
  const handle = input.trim()
  if (handle === '') {
    return null
  }
  if (handle.length > HANDLE_MAX_LENGTH) {
    throw new CustomError(
      'userHandleInvalid',
      `A handle may be at most ${HANDLE_MAX_LENGTH} characters long.`
    )
  }
  if (!HANDLE_PATTERN.test(handle)) {
    throw new CustomError(
      'userHandleInvalid',
      'A handle may contain only letters, digits, dots, underscores and hyphens.'
    )
  }
  return handle
}

function isHandleCollision(err: unknown): boolean {
  const candidate = err as { constraint?: unknown; cause?: { constraint?: unknown } } | null
  return (
    isUniqueViolation(err) &&
    (candidate?.constraint === HANDLE_UNIQUE_INDEX ||
      candidate?.cause?.constraint === HANDLE_UNIQUE_INDEX)
  )
}

function knownPublicFields(value: unknown): ProfilePublicField[] {
  if (!Array.isArray(value)) {
    return []
  }
  return PROFILE_PUBLIC_FIELDS.filter((field) => value.includes(field))
}

export function forcedPublicFields(): ProfilePublicField[] {
  return knownPublicFields(CARDINAL.config.profileVisibility?.forcedPublicFields)
}

export function effectivePublicFields(userFields: unknown): ProfilePublicField[] {
  const chosen = new Set([...knownPublicFields(userFields), ...forcedPublicFields()])
  return PROFILE_PUBLIC_FIELDS.filter((field) => chosen.has(field))
}

/** Null for an account nobody may look at: inactive, or a system account such as the guest. */
export function toPublicProfile(user: {
  id: string
  name: string
  hasAvatar: boolean
  avatarProviderUrl: string | null
  isActive: boolean
  isSystem: boolean
  meta: unknown
  prefs: unknown
}): UserPublicProfile | null {
  if (!user.isActive || user.isSystem) {
    return null
  }
  const meta = (user.meta ?? {}) as Record<string, any>
  const prefs = (user.prefs ?? {}) as Record<string, any>
  const fields: UserPublicProfile['fields'] = {}
  for (const field of effectivePublicFields(prefs.publicFields)) {
    const value = meta[field]
    if (typeof value === 'string' && value.trim() !== '') {
      fields[field] = value
    }
  }
  return {
    id: user.id,
    name: user.name,
    hasAvatar: user.hasAvatar,
    avatarProviderUrl: user.avatarProviderUrl ?? null,
    fields
  }
}

/** Nothing displays an avatar larger than this. */
const avatarSize = 180

/**
 * The ONE place a display name is composed. A call site writing `` `${first} ${last}` `` of its own
 * is the drift this exists to prevent — the three name columns are only guaranteed to agree because
 * every write goes through here.
 */
export function deriveDisplayName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim()
}

/**
 * Resolve the four name columns for an INSERT. The update-path counterpart is
 * {@link Users.updateUser}, which has a stored row to reconcile against and so cannot share this.
 *
 * A single `name` with no halves is authored by definition — there is nothing for it to be derived
 * from — and no split is guessed at here. Passing both marks the row authored only when the given
 * `name` is not what the halves derive to, which is what lets a caller pass a name alongside the
 * halves it already derives from (`init()`'s seeded accounts) without the row being born authored.
 */
export function resolveNameFields(input: {
  name?: string
  firstName?: string
  lastName?: string
}): { name: string; firstName: string; lastName: string; nameLocallyEdited: boolean } {
  const firstName = (input.firstName ?? '').trim()
  const lastName = (input.lastName ?? '').trim()
  const derived = deriveDisplayName(firstName, lastName)
  if (input.name === undefined) {
    return { name: derived, firstName, lastName, nameLocallyEdited: false }
  }
  return {
    name: input.name,
    firstName,
    lastName,
    nameLocallyEdited: input.name.trim() !== derived
  }
}

/**
 * One local-provider user row, as an insert value. Shared by `createUser()`, `importLocalUser()` and
 * `init()`'s seeded administrator, which cannot call each other: reusing `createUser` would
 * double-hash `importLocalUser`'s already-hashed password, and `init` runs before
 * `CARDINAL.data.systemIds` exists.
 *
 * `createdAt`/`updatedAt`/`lastLoginAt` left undefined are omitted by drizzle, so the columns take
 * their own defaults rather than being written as a literal.
 */
function localUserRow(input: {
  id?: string
  strategyId: string
  email: string
  name?: string
  firstName?: string
  lastName?: string
  /** Nothing here calls `bcrypt.hash()`; every caller hashes (or carries) its own. */
  passwordHash: string
  isPasswordKnown: boolean
  mustChangePassword: boolean
  isActive: boolean
  isVerified: boolean
  meta?: { location?: string; jobTitle?: string; pronouns?: string }
  prefs?: {
    timezone?: string
    dateFormat?: string
    timeFormat?: string
    appearance?: string
    aesthetic?: string
    contentWidth?: string
    cvd?: string
  }
  createdAt?: Date
  updatedAt?: Date
  lastLoginAt?: Date
}): typeof usersTable.$inferInsert {
  const meta = input.meta ?? {}
  const prefs = input.prefs ?? {}
  const names = resolveNameFields(input)
  return {
    id: input.id,
    email: input.email.toLowerCase(),
    ...names,
    auth: {
      [input.strategyId]: {
        password: input.passwordHash,
        isPasswordKnown: input.isPasswordKnown,
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
      timezone: prefs.timezone ?? CARDINAL.config.userDefaults?.timezone ?? 'America/New_York',
      dateFormat: prefs.dateFormat ?? CARDINAL.config.userDefaults?.dateFormat ?? 'YYYY-MM-DD',
      timeFormat: prefs.timeFormat ?? CARDINAL.config.userDefaults?.timeFormat ?? '12h',
      appearance: prefs.appearance ?? 'site',
      aesthetic: prefs.aesthetic ?? 'site',
      contentWidth: prefs.contentWidth ?? 'site',
      cvd: prefs.cvd ?? 'none'
    },
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    lastLoginAt: input.lastLoginAt
  }
}

/**
 * Never includes `auth` or `passkeys`. Exported for `models/groups.ts#getGroupUsers`, which pages
 * the same columns off a join onto this table, so a column added to the projection is added once
 * rather than in two lists that drift.
 */
export const userSelection = {
  id: usersTable.id,
  name: usersTable.name,
  firstName: usersTable.firstName,
  lastName: usersTable.lastName,
  email: usersTable.email,
  hasAvatar: usersTable.hasAvatar,
  avatarProviderUrl: usersTable.avatarProviderUrl,
  isSystem: usersTable.isSystem,
  isActive: usersTable.isActive,
  isVerified: usersTable.isVerified,
  createdAt: usersTable.createdAt,
  updatedAt: usersTable.updatedAt,
  lastLoginAt: usersTable.lastLoginAt
}

/**
 * An email collision is part of the return value rather than a thrown error, so a bulk import can
 * report *why* a record didn't land instead of treating it as an unhandled failure.
 */
export type ImportLocalUserResult =
  | { status: 'created'; id: string }
  | { status: 'skipped'; reason: 'email-collision'; existingId: string }

const SYSTEM_USER_EMAIL = 'system@cardinal.invalid'

class Users {
  async getByEmail(email: string) {
    const res = await CARDINAL.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1)
    return res?.[0] ?? null
  }

  async getByProviderLink(strategyId: string, providerId: string) {
    if (!strategyId || providerId === undefined || providerId === null || providerId === '') {
      return null
    }
    const res = await CARDINAL.db
      .select()
      .from(usersTable)
      .where(sql`${usersTable.auth} -> ${strategyId}::text ->> 'id' = ${String(providerId)}::text`)
      .orderBy(usersTable.createdAt)
      .limit(1)
    return res?.[0] ?? null
  }

  async ensureSystemUser(): Promise<string> {
    const id: string = CARDINAL.data.systemIds.systemUserId
    await CARDINAL.db
      .insert(usersTable)
      .values({
        id,
        email: SYSTEM_USER_EMAIL,
        auth: {},
        ...resolveNameFields({ firstName: 'System' }),
        isSystem: true,
        isActive: false,
        isVerified: true,
        meta: {},
        prefs: {
          timezone: 'UTC',
          dateFormat: 'YYYY-MM-DD',
          timeFormat: '24h',
          appearance: 'site',
          aesthetic: 'site',
          contentWidth: 'site',
          cvd: 'none'
        }
      })
      .onConflictDoNothing({ target: usersTable.id })
    return id
  }

  async getById(id: string, db: WikiDbOrTx = CARDINAL.db) {
    const res = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1)
    return res?.[0] ?? null
  }

  /**
   * Identity and the moment only — this answers a dashboard panel readable by anyone in the admin
   * area, a tier below the `read:users` the user list itself needs, so it deliberately carries none
   * of the account state `getUsers()` selects.
   *
   * System accounts are excluded because the guest is one: nothing signs in as it, and a
   * `lastLoginAt` on it would be an artefact rather than a visit.
   */
  async getRecentLogins({ limit = 10 }: { limit?: number } = {}): Promise<RecentLogin[]> {
    return CARDINAL.db
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
   * Every migrated provider-fallback account that has not yet relinked via SSO.
   *
   * Gated on the SAME two conditions `models/login.ts#clearMigratedFallbackLocalAuth` clears
   * together: the local-strategy auth entry's `mustChangePwd` AND `migratedFallbackProvider` both
   * present. `mustChangePwd` alone would also catch a genuine local account an administrator forced
   * a password reset on; `migratedFallbackProvider` alone cannot occur without `mustChangePwd`, but
   * requiring both keeps this query's intent legible without relying on that invariant holding.
   */
  async getFallbackAccounts(): Promise<FallbackAccount[]> {
    const localStrategyId = CARDINAL.data.systemIds.localAuthId
    const providerKeyExpr = sql<string>`(${usersTable.auth} -> ${localStrategyId} ->> 'migratedFallbackProvider')`

    return CARDINAL.db
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

  async searchHandles(prefix: string, limit: number): Promise<{ handle: string; name: string }[]> {
    const pattern = `${escapeLikePattern(prefix.toLowerCase())}%`
    const rows = await CARDINAL.db
      .select({ handle: usersTable.handle, name: usersTable.name })
      .from(usersTable)
      .where(
        and(
          isNotNull(usersTable.handle),
          eq(usersTable.isActive, true),
          eq(usersTable.isSystem, false),
          sql`lower(${usersTable.handle}) LIKE ${pattern}`
        )
      )
      .orderBy(sql`lower(${usersTable.handle})`)
      .limit(limit)
    return rows.flatMap((row) => (row.handle ? [{ handle: row.handle, name: row.name }] : []))
  }

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
      //    have a fixed membership the group-assignment route refuses to change
      conditions.push(eq(usersTable.isSystem, false))
      conditions.push(
        notExists(
          CARDINAL.db
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
        CARDINAL.db
          .select(userSelection)
          .from(usersTable)
          .where(where)
          .orderBy(usersTable.name)
          .limit(limit)
          .offset((page - 1) * limit),
      total: () => CARDINAL.db.select({ total: count() }).from(usersTable).where(where)
    })

    return { total, users: rows }
  }

  /**
   * The stored `auth` blob is keyed by strategy ID and holds secrets, so it is reshaped into a list
   * of providers carrying only state (`isPasswordSet`, `isTfaSetup`) — never the password hash or
   * the TFA secret.
   */
  async getUserDetail(id: string) {
    const results = await CARDINAL.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1)
    const user = results[0]
    if (!user) {
      return null
    }

    const groups = await this.getUserGroups(id)
    const auth = await CARDINAL.models.userCredentials.describeLinkedProviders(user)

    return {
      id: user.id,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
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

  /** Create a new user, authenticated against the local strategy. */
  async createUser({
    name,
    firstName,
    lastName,
    email,
    password,
    isPasswordKnown = true,
    groups = [],
    mustChangePassword = false,
    isVerified = true
  }: {
    /** Optional: a caller with the two halves below instead lets it derive ({@link resolveNameFields}). */
    name?: string
    firstName?: string
    lastName?: string
    email: string
    password: string
    isPasswordKnown?: boolean
    groups?: string[]
    mustChangePassword?: boolean
    /**
     * Defaults to true: an administrator creating the account vouches for the address, and login
     * rejects unverified users with `ERR_USER_NOT_VERIFIED`, which no email can currently clear.
     */
    isVerified?: boolean
  }): Promise<string> {
    const localStrategyId = CARDINAL.data.systemIds.localAuthId
    // -> Resolved here too (the call is idempotent) so the `user:join` hook below reports the
    //    display name that was actually stored, not the `undefined` a halves-only caller passed.
    const names = resolveNameFields({ name, firstName, lastName })
    // -> Hashed before the transaction opens: bcrypt is CPU-bound, not a query, and there is no
    //    reason to hold the checked-out connection idle while it runs.
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

    // -> The insert and its group assignment must land together or not at all: a `setUserGroups`
    //    failure after a committed insert leaves a user row with no memberships behind a 500, and
    //    the administrator's retry hits the email-uniqueness conflict instead of anything useful.
    const userId = await CARDINAL.db.transaction(async (tx) => {
      const result = await tx
        .insert(usersTable)
        .values(
          localUserRow({
            strategyId: localStrategyId,
            email,
            name: names.name,
            firstName: names.firstName,
            lastName: names.lastName,
            passwordHash,
            isPasswordKnown,
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

    CARDINAL.models.flags.authDebug(
      `Created user ${userId} <${email.toLowerCase()}> in ${groups.length} group(s), mustChangePwd: ${mustChangePassword}, verified: ${isVerified}`
    )

    // -> No site context: an account is global, not attributable to a site, and a hook scoped to
    //    one site must not fire on every join instance-wide for want of a site to compare against.
    await CARDINAL.models.hooks.emit('user:join', null, {
      userId,
      metadata: {
        name: names.name,
        email: email.toLowerCase()
      }
    })

    return userId
  }

  /**
   * Create a local-provider user during a 2.5.x -> 3.0 import, carrying the source's already-hashed
   * password over verbatim. It cannot reuse `createUser()`, which bcrypt-hashes whatever string it
   * is handed: re-hashing an existing hash produces a value that can never match the original
   * plaintext, locking every imported account out of its own password.
   *
   * An email collision (`users.email` is unique) is skipped and flagged rather than thrown or
   * silently overwritten, so a partial import is always reported rather than picking a winner
   * quietly. The check-then-insert leaves a narrow race window, so a unique violation from the
   * insert itself is downgraded to the same skip — a same-email race is a collision, not a schema
   * error.
   *
   * 2FA is deliberately not carried over and has no parameter here: a TOTP secret is bound to the
   * authenticator the user enrolled on the source install, so importing it as active either
   * protects nothing (if it was rotated since) or moves a secret across installs without the user's
   * re-consent. Imported accounts re-enroll.
   */
  async importLocalUser({
    name,
    firstName,
    lastName,
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
    /**
     * The 2.5.x source's single `name` column. A source with no separated halves omits the two
     * below and the account is imported with an authored display name — no split is guessed at.
     */
    name?: string
    firstName?: string
    lastName?: string
    email: string
    passwordHash: string
    /** Target-install group UUIDs, already remapped from source ids by the groups importer. */
    groups?: string[]
    mustChangePassword?: boolean
    isVerified?: boolean
    /** Defaults to `false`, never `true`: a deliberately deactivated 2.x account must not come back
     * active when the caller has no source value to give. */
    isActive?: boolean
    meta?: { location?: string; jobTitle?: string; pronouns?: string }
    prefs?: {
      timezone?: string
      dateFormat?: string
      timeFormat?: string
      appearance?: string
      cvd?: string
    }
    /** Carried over so an imported account's "member since" reflects the source install, not the
     * import date. Omitted, each falls back to its column's own default. */
    createdAt?: Date
    updatedAt?: Date
    lastLoginAt?: Date
  }): Promise<ImportLocalUserResult> {
    const normalizedEmail = email.toLowerCase()

    const existing = await this.getByEmail(normalizedEmail)
    if (existing) {
      return { status: 'skipped', reason: 'email-collision', existingId: existing.id }
    }

    const localStrategyId = CARDINAL.data.systemIds.localAuthId
    // -> Idempotent re-resolve, so the `user:join` hook below reports the stored display name.
    const names = resolveNameFields({ name, firstName, lastName })
    let result
    try {
      result = await CARDINAL.db
        .insert(usersTable)
        .values(
          localUserRow({
            strategyId: localStrategyId,
            email: normalizedEmail,
            name: names.name,
            firstName: names.firstName,
            lastName: names.lastName,
            passwordHash,
            isPasswordKnown: true,
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
      if (isUniqueViolation(err)) {
        return { status: 'skipped', reason: 'email-collision', existingId: '' }
      }
      throw err
    }

    const userId = result[0].id
    if (groups.length > 0) {
      await this.setUserGroups(userId, groups)
    }

    CARDINAL.models.flags.authDebug(
      `Imported local user ${userId} <${normalizedEmail}> in ${groups.length} group(s), mustChangePwd: ${mustChangePassword}`
    )

    await CARDINAL.models.hooks.emit('user:join', null, {
      userId,
      metadata: {
        name: names.name,
        email: normalizedEmail
      }
    })

    return { status: 'created', id: userId }
  }

  /**
   * Group membership is handled by `setUserGroups()`.
   *
   * The ONE place an update reconciles `name` against `firstName`/`lastName`; the insert-side
   * counterpart is {@link resolveNameFields}. Every write path that changes a name goes through
   * here, so the three columns cannot silently disagree:
   *
   * - A half edit carrying no `name` re-derives `name`, unless the row is already marked
   *   `nameLocallyEdited`, in which case the authored name stands and only the halves move.
   * - An explicit `name` is stored verbatim and sets that marker, so a hand-authored display name
   *   survives every later half edit. A `name` that is exactly what the halves derive to clears the
   *   marker instead, which is what stops a form submitting all three fields marking every account
   *   it touches.
   * - A caller may pass `nameLocallyEdited` itself to override both rules — the seam a provider
   *   sign-in uses to fill an empty half without it counting as a local edit.
   *
   * A patch touching none of the three fields does not read the row at all.
   */
  async updateUser(id: string, patch: UserPatch, db: WikiDbOrTx = CARDINAL.db): Promise<boolean> {
    const values: Record<string, any> = { ...patch, updatedAt: sql`now()` }
    if (patch.handle !== undefined) {
      values.handle = normalizeHandle(patch.handle)
    }
    if (typeof values.email === 'string') {
      values.email = values.email.toLowerCase()
    }
    if (typeof values.firstName === 'string') {
      values.firstName = values.firstName.trim()
    }
    if (typeof values.lastName === 'string') {
      values.lastName = values.lastName.trim()
    }
    if (patch.name !== undefined || patch.firstName !== undefined || patch.lastName !== undefined) {
      await this.reconcileNameValues(id, patch, values, db)
    }
    try {
      const result = await db.update(usersTable).set(values).where(eq(usersTable.id, id))
      return (result.rowCount ?? 0) > 0
    } catch (err: any) {
      if (isHandleCollision(err)) {
        throw new CustomError('userHandleTaken', 'That handle is already taken.', 409)
      }
      throw err
    }
  }

  /**
   * Split out of {@link Users.updateUser} only for readability — not a second owner of the rule.
   * Mutates `values` in place.
   *
   * Reads the current row on the caller's own `db` handle, so a call inside an open transaction
   * sees that transaction's uncommitted state. A since-deleted user leaves `values` alone: the
   * `UPDATE` that follows matches nothing.
   */
  private async reconcileNameValues(
    id: string,
    patch: UserPatch,
    values: Record<string, any>,
    db: WikiDbOrTx
  ): Promise<void> {
    const [current] = await db
      .select({
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        nameLocallyEdited: usersTable.nameLocallyEdited
      })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1)
    if (!current) {
      return
    }
    const derived = deriveDisplayName(
      values.firstName ?? current.firstName,
      values.lastName ?? current.lastName
    )
    if (patch.name === undefined) {
      const authored = patch.nameLocallyEdited ?? current.nameLocallyEdited
      if (!authored) {
        values.name = derived
      }
      return
    }
    if (patch.nameLocallyEdited === undefined) {
      values.nameLocallyEdited = patch.name.trim() !== derived
    }
  }

  /**
   * `meta` and `prefs` are free-form blobs, so every field is defaulted here rather than trusted to
   * be present — a user created before a given key existed simply has none.
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
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      hasAvatar: user.hasAvatar,
      avatarProviderUrl: user.avatarProviderUrl ?? null,
      handle: user.handle ?? null,
      location: meta.location ?? '',
      jobTitle: meta.jobTitle ?? '',
      pronouns: meta.pronouns ?? '',
      // -> Empty means "whatever the client resolves", which is what the profile page falls back to
      timezone: prefs.timezone ?? '',
      dateFormat: prefs.dateFormat ?? '',
      timeFormat: prefs.timeFormat ?? '12h',
      appearance: prefs.appearance ?? 'site',
      aesthetic: prefs.aesthetic ?? 'site',
      contentWidth: prefs.contentWidth ?? 'site',
      cvd: prefs.cvd ?? 'none',
      // -> Empty means "no preference recorded" — mail then resolves in `en`, the same fallback
      //    `models/locales.ts#resolveString` uses for an unset or unknown locale.
      locale: prefs.locale ?? '',
      // -> No forced default, unlike every field above: `Graph.vue` is the one place that decides
      //    what each control falls back to when unset, rather than it being duplicated here.
      graph: prefs.graph as GraphPrefs | undefined,
      // -> Same reasoning as `graph`: `IconPickerDialog.vue` owns the unset fallback.
      iconPicker: prefs.iconPicker as IconPickerPrefs | undefined,
      publicFields: knownPublicFields(prefs.publicFields),
      forcedPublicFields: forcedPublicFields(),
      searchFilters: prefs.searchFilters as SearchFilter[] | undefined
    }
  }

  async getPublicProfile(id: string): Promise<UserPublicProfile | null> {
    const user = await this.getById(id)
    return user ? toPublicProfile(user) : null
  }

  /**
   * Kept under `prefs.editors[editor]` so each editor owns its own blob and adding a second one
   * needs no migration. The shape is whatever that editor saves; this only guarantees an object.
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
   * Merges at both levels for the same reason `updateProfile` does: another editor's settings, and
   * every other preference, have to survive one editor saving its own.
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
   * The storage half of the per-user email notification toggle; `models/hooks.ts#Hooks.emit()` is
   * the trigger half. Kept at `prefs.notifications.events`, the same per-feature-blob-under-`prefs`
   * shape `getEditorSettings` uses — no migration needed to add or change it. Empty for a user who
   * has never set a preference: subscription is opt-in, not opt-out.
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
   * Merges into `prefs` the same way `setEditorSettings` does, so every other preference survives
   * untouched. Silently drops anything not in `HOOK_EVENTS`: a closed vocabulary, not free text a
   * caller can extend by typo.
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
   * `jsonb_exists()` is the function form of jsonb's `?` containment operator, spelled out so it is
   * not misread as one of Drizzle's own `${}` parameter placeholders.
   *
   * Deliberately instance-wide, with no site or page-permission filtering: a webhook subscription,
   * which this mirrors, isn't scoped to what its owner can read either. A known simplification.
   */
  async listEmailSubscribers(event: HookEvent): Promise<{ id: string }[]> {
    return CARDINAL.db
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
   * An adapter over {@link getEmailNotificationEvents} rather than a second storage location:
   * `Hooks.emit()` already reads that array, so a competing `prefs.eventSubscriptions` blob would
   * leave this settings page changing something the trigger side never looks at.
   *
   * The map is always fully populated over {@link HOOK_EVENTS} -- opting in is explicit, so an
   * event never set, or one added to `HOOK_EVENTS` since the user last saved, reads `false` rather
   * than being silently absent.
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
   * Only the keys present in `patch` change; an event type the caller simply didn't send is left
   * as it was. `patch` is trusted to carry only known {@link HookEvent} keys -- the route schema
   * `UserNotificationSubscriptionsUpdate` is what rejects an unknown one.
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
   * Merges into the `meta` and `prefs` blobs rather than replacing them — an administrator's notes
   * and any key this endpoint does not expose must survive a user saving its profile.
   *
   * @throws `ERR_INVALID_LOCALE` for a non-empty `locale` that names no installed locale
   * @throws `ERR_INVALID_SEARCH_FILTERS` for a `searchFilters` list that fails {@link isSearchFilters}
   */
  async updateProfile(id: string, patch: UserProfilePatch): Promise<UserProfile | null> {
    const user = await this.getById(id)
    if (!user) {
      return null
    }

    // -> Validated against the installed catalogue rather than a static enum: the valid set is only
    //    known at runtime. An empty string clears the preference, so it skips the check.
    if (patch.locale !== undefined && patch.locale !== '') {
      const known = (await CARDINAL.models.locales.getLocales()).some(
        (lc: any) => lc.code === patch.locale
      )
      if (!known) {
        throw new Error('ERR_INVALID_LOCALE')
      }
    }

    if (patch.searchFilters !== undefined && !isSearchFilters(patch.searchFilters)) {
      throw new Error('ERR_INVALID_SEARCH_FILTERS')
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
    if (patch.publicFields !== undefined) {
      prefs.publicFields = knownPublicFields(patch.publicFields)
    }
    if (patch.searchFilters !== undefined) {
      prefs.searchFilters = normalizeSearchFilters(patch.searchFilters)
    }

    // -> Name fields go to `updateUser` untouched: it is the one owner of the
    //    derive-unless-authored rule, so this method neither derives nor decides what counts as
    //    authoring.
    const values: UserPatch = { meta, prefs }
    if (patch.handle !== undefined) {
      values.handle = patch.handle
    }
    for (const key of profileNameKeys) {
      if (patch[key] !== undefined) {
        values[key] = patch[key]
      }
    }
    await this.updateUser(id, values)

    return this.getProfile(id)
  }

  /**
   * The type is sniffed rather than stored: an avatar written while Sharp was installed is a JPEG,
   * one written without it is whatever was uploaded, and nothing records which. Unrecognizable
   * bytes are reported as JPEG, which is what every avatar stored by 2.x is.
   */
  async getAvatar(userId: string): Promise<{ data: Buffer; mime: string } | null> {
    const rows = await CARDINAL.db
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
   * Lets a conditional request (ETag) be answered without pulling the avatar blob back out of the
   * database.
   */
  async getAvatarHash(userId: string): Promise<string | null> {
    const rows = await CARDINAL.db
      .select({ hash: userAvatars.hash })
      .from(userAvatars)
      .where(eq(userAvatars.id, userId))
      .limit(1)
    return rows[0]?.hash ?? null
  }

  /**
   * Normalized to a square JPEG when the Sharp extension is installed — an avatar is displayed at
   * one small size, so there is no reason to keep a multi-megabyte original around. Without Sharp
   * the uploaded bytes are stored as they came in, which is why reading one sniffs the type.
   *
   * @param data The uploaded image, already known to be one of the supported formats
   */
  async setAvatar(userId: string, data: Buffer): Promise<void> {
    const normalized = (await resizeImageToSquareJpeg(data, avatarSize)) ?? data
    // -> The same sha1-hex digest `controllers/user.ts` computes from the blob for its ETag, so a
    //    hash-only reader agrees with what a full blob read would have produced.
    const hash = crypto.createHash('sha1').update(normalized).digest('hex')
    await CARDINAL.db
      .insert(userAvatars)
      .values({ id: userId, data: normalized, hash })
      .onConflictDoUpdate({ target: userAvatars.id, set: { data: normalized, hash } })
    await CARDINAL.db
      .update(usersTable)
      .set({ hasAvatar: true, updatedAt: sql`now()` })
      .where(eq(usersTable.id, userId))
  }

  async clearAvatar(userId: string): Promise<void> {
    await CARDINAL.db.delete(userAvatars).where(eq(userAvatars.id, userId))
    await CARDINAL.db
      .update(usersTable)
      .set({ hasAvatar: false, updatedAt: sql`now()` })
      .where(eq(usersTable.id, userId))
  }

  /**
   * The one shared write path every provider integration calls into to record an avatar picked up
   * at login, so none of them implement their own caching or precedence logic. It does no fetching:
   * the caller resolves the URL -- the provider's own, or one pointing at a locally re-hosted copy
   * it made itself -- and this only caches it onto `users.avatarProviderUrl`.
   *
   * A manually-uploaded avatar always wins, so this is a no-op whenever `hasAvatar` is set: a
   * provider login can never silently replace what the user chose to upload. A blank or
   * whitespace-only URL is also a no-op, which is how a caller says its provider reported none.
   */
  async syncAvatarFromProvider(
    userId: string,
    pictureUrl: string | null | undefined
  ): Promise<boolean> {
    const url = pictureUrl?.trim()
    if (!url) {
      return false
    }
    const rows = await CARDINAL.db
      .select({ hasAvatar: usersTable.hasAvatar })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1)
    if (!rows[0] || rows[0].hasAvatar) {
      return false
    }
    await CARDINAL.db
      .update(usersTable)
      .set({ avatarProviderUrl: url, updatedAt: sql`now()` })
      .where(eq(usersTable.id, userId))
    return true
  }

  /**
   * Identity only — never a group's permissions or page rules, which a user has no business
   * reading about itself.
   */
  async getUserGroups(userId: string): Promise<Array<{ id: string; name: string }>> {
    return CARDINAL.db
      .select({ id: groupsTable.id, name: groupsTable.name })
      .from(userGroups)
      .innerJoin(groupsTable, eq(groupsTable.id, userGroups.groupId))
      .where(eq(userGroups.userId, userId))
      .orderBy(groupsTable.name)
  }

  /**
   * Identity only, like `getUserGroups()` — never member count or any other metadata — for the
   * profile page's admin-gated "other groups" section.
   */
  async getNonMemberGroups(userId: string): Promise<Array<{ id: string; name: string }>> {
    return CARDINAL.db
      .select({ id: groupsTable.id, name: groupsTable.name })
      .from(groupsTable)
      .where(
        notExists(
          CARDINAL.db
            .select({ exists: sql`1` })
            .from(userGroups)
            .where(and(eq(userGroups.groupId, groupsTable.id), eq(userGroups.userId, userId)))
        )
      )
      .orderBy(groupsTable.name)
  }

  async getUserGroupIds(userId: string): Promise<string[]> {
    const rows = await CARDINAL.db
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .where(eq(userGroups.userId, userId))
    return rows.map((r: any) => r.groupId)
  }

  /**
   * Replace a user's group membership with exactly the given groups.
   *
   * Unknown group IDs are ignored rather than failing the whole update, so a stale client does not
   * block an otherwise valid save. So is a membership that may not be granted — see
   * `groups.guestMembershipViolation`: this is the one call that sets every group at once, reached
   * from creating a user, editing one, and enrolling one an identity provider has just sent, so
   * dropping here keeps all three honest without any of them knowing about the guests group.
   */
  async setUserGroups(
    userId: string,
    groupIds: string[],
    db: WikiDbOrTx = CARDINAL.db
  ): Promise<void> {
    const user = await this.getById(userId, db)
    const allowed = groupIds.filter(
      (groupId) => !CARDINAL.models.groups.guestMembershipViolation(groupId, user)
    )
    if (allowed.length !== groupIds.length) {
      CARDINAL.logger.warn('auth', 'dropped group assignments that may not be granted', {
        user: userId,
        dropped: groupIds.length - allowed.length
      })
    }
    /*
      The guest account keeps the membership it was seeded with whatever was asked for: its groups
      are not an administrator's to set, and an empty list would leave anonymous access resolving
      against no rules at all.
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

    // -> One transaction: `userGroups` has no soft-replace path, so an unwrapped delete-then-insert
    //    leaves a window where a concurrent grant makes the insert fail on the composite primary
    //    key, or a dropped connection leaves the user in no groups at all -- no admin access, no
    //    page rules -- with the caller's error saying nothing about membership having been wiped.
    //    Transacting on `db`, not the ambient `CARDINAL.db`, is what lets a caller's own open
    //    transaction be joined rather than raced: drizzle nests it as a savepoint.
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
   * One transaction, so a failure partway through leaves no earlier write in the sequence committed
   * behind a 500.
   *
   * The route keeps its pre-flight guards (duplicate email, system-user protection, `manage:system`
   * escalation, last-root-admin) outside this method, and calls `auditLog.record()` itself
   * afterwards — that call cannot throw and records what was asked for, not what this method made
   * of it, so it has no reason to join the transaction.
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
    await CARDINAL.db.transaction(async (tx) => {
      if (patch && Object.keys(patch).length > 0) {
        await this.updateUser(id, patch, tx)
      }
      if (groups !== undefined) {
        await this.setUserGroups(id, groups, tx)
      }
      if (authFlags !== undefined) {
        await CARDINAL.models.userCredentials.setUserAuthFlags(id, authFlags, tx)
      }
      if (patch?.isActive === false || groups !== undefined) {
        await CARDINAL.models.sessions.clearSessionsFromUser(id, tx)
      }
      // -> A `resetPwd` (or other) token minted before deactivation would otherwise stay redeemable
      //    afterwards: `afterLoginChecks()` refuses the login it ends in, but only once
      //    `resetPassword()` has already rewritten the password hash.
      if (patch?.isActive === false) {
        await CARDINAL.models.userCredentials.clearKeysFromUser(id, tx)
      }
    })
  }

  /**
   * `pageEditSubmissions.authorId` also references `users.id` with no `onDelete` and blocks
   * `deleteUser()`'s foreign key check the same way, but is deliberately left alone: an open page
   * edit suggestion has no "reassign" remedy, only approve/reject (`models/approvals.ts`). So this
   * clears that violation for authored/created/owned pages and authored assets only.
   *
   * A single page can carry `fromUserId` in more than one of its three columns at once, so `pages`
   * is updated with one statement repointing only the columns that match, rather than three that
   * would each report the same page as touched.
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

    return CARDINAL.db.transaction(async (tx) => {
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
   * Group assignments cascade, but sessions, keys and the avatar do not — they are login/profile
   * artifacts, so they are cleared here rather than blocking the delete. Open edit submissions are
   * discarded rather than nulled: the column is nullable and one could survive as an anonymous
   * suggestion, but that silently changes what the submission is instead of removing it. References
   * from authored content (pages, assets) have no cascade either and make this throw, deliberately
   * — the delete is refused rather than silently orphaning content.
   *
   * One transaction, so a delete refused by that foreign-key conflict leaves the sessions, keys and
   * avatar intact rather than already destroyed.
   */
  async deleteUser(id: string): Promise<boolean> {
    return CARDINAL.db.transaction(async (tx) => {
      await tx.delete(userKeys).where(eq(userKeys.userId, id))
      await tx.delete(sessionsTable).where(eq(sessionsTable.userId, id))
      await tx.delete(userAvatars).where(eq(userAvatars.id, id))
      await tx.delete(pageEditSubmissions).where(eq(pageEditSubmissions.authorId, id))
      const result = await tx.delete(usersTable).where(eq(usersTable.id, id))
      return (result.rowCount ?? 0) > 0
    })
  }

  async init(ids: SystemIds): Promise<void> {
    CARDINAL.logger.debug('config', 'seeding the default users')

    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@example.com'
    // -> No fixed default password: that would be one credential every zero-config install shares.
    //    This one is generated here and derivable from nothing else the instance stores. 18 random
    //    bytes is 144 bits of entropy, comfortably past the local strategy's own `minLength: 8`
    //    floor, and `base64url` has none of `+`/`/`/`=` to trip a naive copy-paste.
    const generatedPassword = process.env.ADMIN_PASS
      ? undefined
      : crypto.randomBytes(18).toString('base64url')
    const adminPassword = process.env.ADMIN_PASS || generatedPassword!

    if (generatedPassword) {
      // -> At `error` because it must render whatever `logLevel`/`logScopes` an operator configured:
      //    this is the ONLY place the password is ever shown, so a filtered-out line seeds an
      //    account nobody can log into, and `error` is the one level
      //    `core/logger.ts#effectiveLevel` never gates out. Printing the credential is a deliberate
      //    exception to the "identifiers, never identities" logging rule -- it is the only one the
      //    operator has for this account.
      CARDINAL.logger.error(
        'config',
        'seeded a one-time admin password -- copy it now, it will not be shown again',
        { email: adminEmail, password: generatedPassword }
      )
    }

    await CARDINAL.db.insert(usersTable).values([
      localUserRow({
        id: ids.userAdminId,
        // -> `CARDINAL.data.systemIds` is not populated yet at seeding time, so the local
        //    strategy's id comes from the ids being seeded rather than from that global
        strategyId: ids.authModuleId,
        email: adminEmail,
        // -> A mononym: `firstName` alone derives `name` and leaves the row unmarked, so an
        //    administrator who later fills in real halves gets the display name re-derived rather
        //    than being stuck behind an "authored" marker.
        firstName: 'Administrator',
        passwordHash: await bcrypt.hash(adminPassword, BCRYPT_ROUNDS),
        isPasswordKnown: true,
        mustChangePassword: !process.env.ADMIN_PASS,
        isActive: true,
        isVerified: true
      }),
      {
        id: ids.userGuestId,
        email: 'guest@example.com',
        auth: {},
        ...resolveNameFields({ firstName: 'Guest' }),
        isSystem: true,
        isActive: true,
        isVerified: true,
        meta: {},
        prefs: {
          timezone: 'America/New_York',
          dateFormat: 'YYYY-MM-DD',
          timeFormat: '12h',
          appearance: 'site',
          aesthetic: 'site',
          contentWidth: 'site',
          cvd: 'none'
        }
      }
    ])

    await CARDINAL.db.insert(userGroups).values([
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
   * The one place every login path (local, provider, passkey, and the 2FA / password-change
   * continuations) ends up, via `afterLoginChecks`.
   *
   * Regenerates the session id first, against session fixation: `saveUninitialized: false` does not
   * stop an attacker planting a session id on a victim before they log in, since two public
   * pre-login endpoints already force a store write and a `Set-Cookie`.
   * `@fastify/session#regenerate()` reassigns the fresh session onto `req.session` in place, so
   * every later read — here and back up the call chain — sees the regenerated one. Nothing needs
   * carrying across: a pre-login session only ever holds `authFlow`/`passkeyLogin`, both cleared by
   * their own callers once the ceremony finishes.
   */
  async updateSession(user: any, req: any): Promise<void> {
    await req.session.regenerate()

    req.session.authenticated = true
    req.session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      hasAvatar: user.hasAvatar,
      avatarProviderUrl: user.avatarProviderUrl ?? null,
      timezone: user.prefs?.timezone,
      dateFormat: user.prefs?.dateFormat,
      timeFormat: user.prefs?.timeFormat,
      appearance: user.prefs?.appearance,
      aesthetic: user.prefs?.aesthetic,
      contentWidth: user.prefs?.contentWidth,
      cvd: user.prefs?.cvd,
      locale: user.prefs?.locale
    }
    req.session.permissions = uniq(flatten(user.groups?.map((g: any) => g.permissions)))
    // -> Group ids as well as their permissions, since navigation items are limited per group
    req.session.groups = (user.groups ?? []).map((g: any) => g.id)
  }
}

export const users = new Users()
