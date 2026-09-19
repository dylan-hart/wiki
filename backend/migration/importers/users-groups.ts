import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import type { WikiDb } from '../../core/db.ts'
import {
  groups as groupsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../../db/schema.ts'
import { BCRYPT_ROUNDS } from '../../helpers/common.ts'
import { randomToken } from '../../helpers/randomToken.ts'
import { normalizeRuleTags, type GroupRule, type GroupRuleMatch } from '../../models/groups.ts'
import type { SourceRecord } from '../connector.ts'
import { coerceSourceBoolean } from '../source-coercion.ts'
import { KNOWN_3_0_AUTH_MODULES } from '../report.ts'

/**
 * Users/Groups importer engine for the 2.5.x → 3.0 migration: one per-record importer factory per
 * entity (`groups`, `users`, `userGroups`) for `phases/users.ts` to drive. Not the CLI — nothing
 * here opens a database or parses argv — and it takes no `CARDINAL` dependency of its own: the CLI
 * resolves the ids it needs (local strategy, system groups) and passes them in, which is what keeps
 * the converters unit-testable.
 *
 * The write order — groups, users, then `userGroups` — is load-bearing: `userGroups` resolves both
 * of its ids through the `Map<number, string>` source-id -> target-UUID maps the first two build
 * (2.5.x has integer PKs, 3.0 `uuid().defaultRandom()`).
 *
 * There is no re-run safety by design: this runs once against a fresh, empty destination, so an
 * insert failure is a genuine conflict to report rather than an "already imported" case to detect.
 */

export type RecordStatus = 'created' | 'skipped' | 'conflicted' | 'flagged'

export interface RecordResult {
  /** The record's 2.x integer id, or a synthetic `${userId}:${groupId}` label for a `userGroups`
   * row, whose own surrogate id has no destination in 3.0. */
  sourceId: number | string
  targetId?: string
  status: RecordStatus
  /** Required for every non-`created` status. */
  message?: string
}

export interface EntityImportSummary {
  created: number
  skipped: number
  conflicted: number
  flagged: number
  records: RecordResult[]
}

/** One entry per account created through the provider fallback: what the dry-run report lists so an
 * administrator can see which accounts need a password reset before they are usable. */
export interface ProviderFallbackFlag {
  email: string
  sourceProvider: string
  reason: string
}

/** A 2.x `isSystem` row (the Administrators/Guests groups, the Administrator/Guest users) already
 * exists in any 3.0 install, seeded by `Groups.init()`/`Users.init()`. Checked before any converter
 * runs, so no plugged-in converter can create a duplicate. */
function isSystemSourceRecord(sourceRecord: SourceRecord): boolean {
  return readSourceBoolean(sourceRecord, 'isSystem') === true
}

/** 2.5.x's fixed source id for the Administrators group. Recognizing it matters because that
 * group's own row is skipped on import, so it never gets an entry in the group id map. */
const SOURCE_SYSTEM_GROUP_ADMIN_ID = 1

/** 2.5.x's fixed source id for the Guests group -- same rationale as `SOURCE_SYSTEM_GROUP_ADMIN_ID`. */
const SOURCE_SYSTEM_GROUP_GUEST_ID = 2

/** This install's real system-group ids, supplied by the caller so `createUserGroupImporter()` can
 * remap a membership that pointed at the *source's* skipped system group.
 *
 * The obvious lookup is wrong: `CARDINAL.data.systemIds` has no admin group id — `initDbValues()`
 * generates it as a local variable, and `Settings.init()` persists it as
 * `settings.auth.rootAdminGroupId` (reloaded onto `CARDINAL.config.auth.rootAdminGroupId`). Only the
 * guest id is `CARDINAL.data.systemIds.guestsGroupId`. */
export interface SystemGroupIds {
  admin: string
  guest: string
}

function emptySummary(): EntityImportSummary {
  return {
    created: 0,
    skipped: 0,
    conflicted: 0,
    flagged: 0,
    records: []
  }
}

function record(summary: EntityImportSummary, result: RecordResult): void {
  summary[result.status]++
  summary.records.push(result)
}

export type NewGroupRow = typeof groupsTable.$inferInsert
export type NewUserRow = typeof usersTable.$inferInsert

/** `providerFallback` rides along with a `created` row: such an account is genuinely created and
 * *also* flagged for admin attention, not one or the other. */
export type ConversionOutcome<TRow> =
  | {
      status: 'created'
      row: TRow
      providerFallback?: ProviderFallbackFlag
      /** Note on an otherwise-successful conversion — dropped permissions or rules, or 2FA that
       * could not be carried over — so the loss is visible in the dry-run report. */
      message?: string
    }
  | { status: 'skipped' | 'conflicted' | 'flagged'; message: string }

export type GroupConverter = (
  source: SourceRecord
) => ConversionOutcome<NewGroupRow> | Promise<ConversionOutcome<NewGroupRow>>

export type UserConverter = (
  source: SourceRecord
) => ConversionOutcome<NewUserRow> | Promise<ConversionOutcome<NewUserRow>>

/** The global permissions a 2.x export could actually contain — not 3.0's full vocabulary, since
 * this only filters legacy input. 2.x's other entries (`read:pages`, `write:pages`, …) merely gated
 * whether a group's page rules took effect at all; 3.0 has no such global gate, the rules alone
 * govern page access, so they are dropped. `manage:glossary` is absent because the glossary is
 * 3.0-only: no 2.x source can name it. */
const GLOBAL_PERMISSIONS = new Set([
  'manage:users',
  'manage:groups',
  'manage:navigation',
  'manage:theme',
  'manage:sites',
  'manage:system',
  'access:admin'
])

/** The five `match` values 2.x's `PageRule.match` enum has (`server/graph/schemas/group.graphql`
 * @ `requarks/wiki`). 3.0's sixth, `TAGALL`, has no 2.x source, so a rule claiming it (or anything
 * else) is treated as malformed rather than guessed at. */
const VALID_2X_RULE_MATCH = new Set(['START', 'END', 'REGEX', 'TAG', 'EXACT'])

/** See `coerceSourceBoolean`: the export-bundle path can carry integer 0/1 as well as a real
 * boolean. */
function readSourceBoolean(source: SourceRecord, column: string): boolean | undefined {
  return coerceSourceBoolean(source[column])
}

/** Non-string elements are dropped rather than thrown on: a 2.x jsonb column may hold anything. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/** 2.x rules carry no `name` of their own. An empty path is 2.x's convention for "the whole site",
 * hence the generic label. A `TAG` rule labels itself with its `tags`, since `convertPageRule`
 * empties `path` for one and the generic label would drop the one thing that made it specific. */
function synthesizeRuleName(
  rule: { match: string; path: string; tags?: string[] },
  index: number
): string {
  const addressed = rule.match === 'TAG' ? (rule.tags ?? []).join(', ') : rule.path
  return addressed
    ? `Imported Rule ${index + 1}: ${rule.match} ${addressed}`
    : `Imported Rule ${index + 1}`
}

/**
 * One 2.x `pageRules[]` element -> 3.0's `GroupRule`, or `undefined` when the element is too
 * malformed to convert; the caller drops and counts those rather than failing the whole group.
 *
 * - `FORCEALLOW` is never produced: 2.x has no concept a force-allow rule could come from.
 * - `id` is freshly generated — nothing cross-table references a 2.x rule id.
 * - `sites` is always `[]`: 2.x predates multi-site, so an imported rule applies everywhere.
 * - A `TAG` rule's 2.x `path` held a comma-separated tag list (2.x had no tags field), so it splits
 *   into `tags` here — normalized as `updateGroup` does at write time — and `path` is left empty,
 *   since nothing in 3.0 reads `path` for a `TAG` rule.
 * - `write:tags` has no 2.x source concept: 2.x tags carried no access implication of their own, so
 *   a rule granting `write:pages` grants it alongside, or an imported group's editors land unable to
 *   retag anything they can otherwise edit.
 */
function convertPageRule(raw: unknown, index: number): GroupRule | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const source = raw as Record<string, unknown>
  const deny = readSourceBoolean(source, 'deny')
  const rawMatch = source.match
  if (deny === undefined || typeof rawMatch !== 'string' || !VALID_2X_RULE_MATCH.has(rawMatch)) {
    return undefined
  }
  const match = rawMatch as GroupRuleMatch
  const sourcePath = typeof source.path === 'string' ? source.path : ''
  const isTagRule = match === 'TAG'
  const tags = isTagRule ? normalizeRuleTags(sourcePath.split(',')) : []
  const path = isTagRule ? '' : sourcePath
  const roles = asStringArray(source.roles)
  if (roles.includes('write:pages') && !roles.includes('write:tags')) {
    roles.push('write:tags')
  }

  return {
    id: crypto.randomUUID(),
    name: synthesizeRuleName({ match, path, tags }, index),
    roles,
    match,
    mode: deny ? 'DENY' : 'ALLOW',
    path,
    locales: asStringArray(source.locales),
    sites: [],
    tags
  }
}

/** Builds the `GroupConverter`. A dropped permission or malformed rule is reported on the outcome's
 * `message` and the conversion still counts as `created` — one bad rule never fails a whole group. */
export function createGroupConverter(): GroupConverter {
  return (source) => {
    if (readSourceBoolean(source, 'isSystem') === true) {
      return {
        status: 'skipped',
        message:
          "system groups (Administrators/Users/Guests) are already seeded by 3.0's own Groups.init() and are not imported"
      }
    }

    const name = readSourceString(source, 'name')
    if (!name) {
      return { status: 'skipped', message: 'source group record has no name' }
    }

    const sourcePermissions = asStringArray(source.permissions)
    const permissions = sourcePermissions.filter((permission) => GLOBAL_PERMISSIONS.has(permission))
    const droppedPermissionCount = sourcePermissions.length - permissions.length

    const sourceRules = Array.isArray(source.pageRules) ? source.pageRules : []
    const rules: GroupRule[] = []
    let droppedRuleCount = 0
    sourceRules.forEach((raw, index) => {
      const converted = convertPageRule(raw, index)
      if (converted) {
        rules.push(converted)
      } else {
        droppedRuleCount++
      }
    })

    const notes: string[] = []
    if (droppedPermissionCount > 0) {
      notes.push(
        `dropped ${droppedPermissionCount} permission(s) that only gated page-rule effectiveness in 2.x and have no 3.0 global equivalent`
      )
    }
    if (droppedRuleCount > 0) {
      notes.push(`dropped ${droppedRuleCount} malformed page rule(s)`)
    }

    const row: NewGroupRow = { name, permissions, rules, isSystem: false }
    return notes.length > 0
      ? { status: 'created', row, message: notes.join('; ') }
      : { status: 'created', row }
  }
}

/** The 2.x `providerKey` values naming a 3.0 authentication module that exists, aliased from
 * `../report.ts` rather than restated so the two cannot drift. It only picks the fallback *reason* —
 * every non-`local` provider falls back regardless (`needsProviderFallback()`). */
const IMPLEMENTED_PROVIDER_MODULES = KNOWN_3_0_AUTH_MODULES

/**
 * Every `providerKey` but `local` routes through the local-strategy fallback, a provider 3.0
 * implements included: 3.0 keys `auth` by strategy-instance UUID, and a fresh install's same-module
 * strategy (if configured at all) will not share the source's client id/secret, so the linked
 * external account cannot be assumed to resolve here. A `local` password carries over on its own
 * path instead.
 */
export function needsProviderFallback(providerKey: string): boolean {
  return providerKey !== 'local'
}

function providerFallbackReason(providerKey: string): string {
  return IMPLEMENTED_PROVIDER_MODULES.has(providerKey)
    ? `source provider '${providerKey}' is implemented in 3.0, but a fresh install's ${providerKey} strategy (if configured at all) would not share the source's client id/secret, so the linked account cannot be assumed to resolve on this install`
    : `source provider '${providerKey}' has no 3.0-native implementation (see backend/modules/authentication/ and docs/migration/2.5x-settings-auth-storage-field-mapping.md's Part 2 provider inventory for the confirmed no-destination providers)`
}

/** An empty string counts as absent, so a blank source field is reported rather than silently
 * accepted. */
function readSourceString(source: SourceRecord, column: string): string | undefined {
  const raw = source[column]
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/** A live `PostgresSourceConnector` hands back a real `Date`; a bundle/JSON-backed one an ISO
 * string. Anything else degrades to `undefined` so the target column defaults, rather than one bad
 * timestamp blocking a whole record. */
export function readSourceDate(source: SourceRecord, column: string): Date | undefined {
  const raw = source[column]
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? undefined : raw
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const millis = Date.parse(raw)
    return Number.isNaN(millis) ? undefined : new Date(millis)
  }
  return undefined
}

/** Accepts what `helpers/totp.ts#base32Decode` accepts (case-insensitive, tolerant of whitespace,
 * dashes and `=` padding), so a secret this passes is one that decoder will take. Duplicated rather
 * than imported: the shared format is a public standard (RFC 4648 base32), not a contract between
 * these two files. Not a general-purpose validator. */
function isCarryableTotpSecret(secret: string): boolean {
  const normalized = secret.toUpperCase().replaceAll(/[\s-]/g, '').replaceAll('=', '')
  return normalized.length > 0 && /^[A-Z2-7]+$/.test(normalized)
}

/**
 * What both `UserConverter`s write into a strategy's `tfaIsActive`/`tfaSecret`.
 *
 * 2.5.x's TOTP (`node-2fa@1.1.2`, over `notp` + `thirty-two`) is the same RFC 6238 construction this
 * install verifies against — HMAC-SHA1, a 30-second step, 6 digits, base32 secret — so a 2.x secret
 * is byte-compatible and copied verbatim, no re-encoding. 2.x has no recovery-code equivalent at
 * all, so a migrated account with 2FA carried over starts with none;
 * `UserCredentials#adminInvalidateTfa` is the way out if one locks itself out.
 *
 * 2FA is dropped to `false`/`''` when the source's `tfaIsActive` is not `true` (nothing to carry),
 * and when it is `true` but the secret is missing or does not decode as base32 — that second case
 * returns a `note` for the record's dry-run entry, since importing an unusable secret as active
 * would lock the account out with no recovery path.
 */
function convertTfa(source: SourceRecord): {
  tfaIsActive: boolean
  tfaSecret: string
  note?: string
} {
  if (readSourceBoolean(source, 'tfaIsActive') !== true) {
    return { tfaIsActive: false, tfaSecret: '' }
  }
  const rawSecret = readSourceString(source, 'tfaSecret')
  if (!rawSecret || !isCarryableTotpSecret(rawSecret)) {
    return {
      tfaIsActive: false,
      tfaSecret: '',
      note:
        '2FA was enabled on the 2.x source but its stored secret is missing or not a valid TOTP ' +
        'secret; imported with 2FA off — this account needs 2FA re-enabled'
    }
  }
  return { tfaIsActive: true, tfaSecret: rawSecret }
}

export interface ProviderFallbackConverterOptions {
  /** Target UUID of this install's local authentication strategy; the CLI supplies it from
   * `CARDINAL.data.systemIds.localAuthId`. */
  localStrategyId: string
}

/**
 * The `UserConverter` for every non-`local` provider. The account is created against this install's
 * local strategy with the "provider-authenticated, no usable local password" shape
 * `loginWithProvider()` gives a brand-new provider account, except `mustChangePwd` is forced `true`:
 * unlike that signup, this account has no working sign-in path here until an administrator resets
 * it. Each created account also carries a `ProviderFallbackFlag` for the dry-run report.
 *
 * The local-strategy auth entry records the source `providerKey` verbatim as
 * `migratedFallbackProvider`, for admin visibility only — never to auto-resolve a strategy, since
 * 3.0 keys `auth` by strategy-instance UUID (see `needsProviderFallback()`). It tells a reviewer
 * which provider the user needs relinking to, and lets a cleanup path tell an orphaned migration
 * fallback from an ordinary local account that happens to carry `mustChangePwd`.
 * `createLocalUserConverter()` never writes it: a real `local` source user has no foreign
 * `providerKey` to record.
 *
 * A `local` source user comes back `flagged`, not `skipped` — the record is real and needs handling,
 * just not here — so a caller using only this converter still sees every record accounted for.
 */
export function createProviderFallbackUserConverter(
  options: ProviderFallbackConverterOptions
): UserConverter {
  return async (source) => {
    const providerKey = readSourceString(source, 'providerKey')
    if (providerKey === undefined) {
      return {
        status: 'flagged',
        message: 'source user record has no providerKey; cannot determine provider routing'
      }
    }

    if (!needsProviderFallback(providerKey)) {
      return {
        status: 'flagged',
        message: `source provider '${providerKey}' is not handled by the provider-fallback converter ('local' — see Users.importLocalUser)`
      }
    }

    const email = readSourceString(source, 'email')?.toLowerCase()
    if (!email) {
      return { status: 'skipped', message: 'source user record has no email address' }
    }
    const name = readSourceString(source, 'name') ?? email
    // -> 2.x's tfa columns live on the user row itself, independent of providerKey, so a
    //    fallback-routed account carries its 2FA state over exactly like a local-provider one.
    const tfa = convertTfa(source)

    const row: NewUserRow = {
      email,
      name,
      auth: {
        [options.localStrategyId]: {
          password: await bcrypt.hash(randomToken(24), BCRYPT_ROUNDS),
          mustChangePwd: true,
          restrictLogin: false,
          tfaIsActive: tfa.tfaIsActive,
          tfaRequired: false,
          tfaSecret: tfa.tfaSecret,
          // -> No recovery codes: 2.x has no equivalent to carry over.
          migratedFallbackProvider: providerKey
        }
      },
      isSystem: false,
      // -> Never assumed: an account deliberately deactivated on the source must not come back
      //    active. 2.x's `users.isActive` is non-nullable, so the `?? false` only covers a
      //    malformed row.
      isActive: readSourceBoolean(source, 'isActive') ?? false,
      isVerified: readSourceBoolean(source, 'isVerified') ?? true,
      meta: {
        location: readSourceString(source, 'location') ?? '',
        jobTitle: readSourceString(source, 'jobTitle') ?? '',
        // -> 3.0-only field, no 2.x source column.
        pronouns: ''
      },
      prefs: {
        timezone: readSourceString(source, 'timezone') ?? 'America/New_York',
        dateFormat: readSourceString(source, 'dateFormat') ?? 'YYYY-MM-DD',
        // -> No 2.x source column.
        timeFormat: '12h',
        appearance: readSourceString(source, 'appearance') ?? 'site',
        // -> 3.0-only field, no 2.x source column.
        cvd: 'none'
      },
      createdAt: readSourceDate(source, 'createdAt'),
      updatedAt: readSourceDate(source, 'updatedAt'),
      lastLoginAt: readSourceDate(source, 'lastLoginAt')
    }

    return {
      status: 'created',
      row,
      providerFallback: {
        email,
        sourceProvider: providerKey,
        reason: providerFallbackReason(providerKey)
      },
      message: tfa.note
    }
  }
}

export interface LocalUserConverterOptions {
  localStrategyId: string
}

/**
 * The `UserConverter` for 2.x's `local` provider: a row builder rather than a call to
 * `Users.importLocalUser()`, whose own `getByEmail`/insert and `{status, id}` return do not fit the
 * `convert -> writer.insertUser(row)` pattern the importers drive. The source's bcrypt hash is
 * copied verbatim. Boolean columns go through `coerceSourceBoolean()`, not a bare `=== true`: the
 * export-bundle connector represents 2.x booleans as JSON `0`/`1` on MySQL/MariaDB/SQLite, and every
 * such row would otherwise read as `false`.
 */
export function createLocalUserConverter(options: LocalUserConverterOptions): UserConverter {
  return (source: SourceRecord) => {
    const email =
      typeof source.email === 'string' && source.email.length > 0
        ? source.email.toLowerCase()
        : undefined
    if (!email) {
      return { status: 'skipped', message: 'source user record has no email address' }
    }
    const passwordHash = typeof source.password === 'string' ? source.password : undefined
    if (!passwordHash) {
      return {
        status: 'flagged',
        message: 'source local-provider user has no password hash to carry over'
      }
    }
    const name = typeof source.name === 'string' && source.name.length > 0 ? source.name : email
    const tfa = convertTfa(source)

    const row: NewUserRow = {
      email,
      name,
      auth: {
        [options.localStrategyId]: {
          password: passwordHash,
          mustChangePwd: coerceSourceBoolean(source.mustChangePwd) ?? false,
          restrictLogin: false,
          tfaIsActive: tfa.tfaIsActive,
          tfaRequired: false,
          tfaSecret: tfa.tfaSecret
        }
      },
      isSystem: false,
      isActive: coerceSourceBoolean(source.isActive) ?? false,
      // -> `false`, not the fallback converter's `true`: for a local account this column tracks
      //    2.x's own email-verification flow, so a missing value is conservatively "not verified".
      //    A provider-authenticated account had its email verified externally, hence that default.
      isVerified: coerceSourceBoolean(source.isVerified) ?? false,
      meta: {
        location: typeof source.location === 'string' ? source.location : '',
        jobTitle: typeof source.jobTitle === 'string' ? source.jobTitle : '',
        pronouns: ''
      },
      prefs: {
        timezone: typeof source.timezone === 'string' ? source.timezone : 'America/New_York',
        dateFormat: typeof source.dateFormat === 'string' ? source.dateFormat : 'YYYY-MM-DD',
        timeFormat: '12h',
        appearance: typeof source.appearance === 'string' ? source.appearance : 'site',
        cvd: 'none'
      },
      createdAt: readSourceDate(source, 'createdAt'),
      updatedAt: readSourceDate(source, 'updatedAt'),
      lastLoginAt: readSourceDate(source, 'lastLoginAt')
    }

    return { status: 'created', row, message: tfa.note }
  }
}

export function composeUserConverters(
  local: UserConverter,
  fallback: UserConverter
): UserConverter {
  return (source: SourceRecord) =>
    source.providerKey === 'local' ? local(source) : fallback(source)
}

export interface UsersGroupsWriter {
  insertGroup(row: NewGroupRow): Promise<{ id: string }>
  insertUser(row: NewUserRow): Promise<{ id: string }>
  insertUserGroup(userId: string, groupId: string): Promise<void>
  /** Only for `createUserGroupImporter()`'s remap onto one of THIS install's system groups, never
   * for an ordinary imported group. Distinct from `insertUserGroup()` because the real writer must
   * go through `Groups.assignUserToGroup()`: it runs `guestMembershipViolation()` and de-duplicates,
   * both of which matter for a system group and not for a fresh, just-created one. */
  assignUserToSystemGroup(userId: string, groupId: string): Promise<void>
}

/** Real writer. `insertGroup()` is the one non-Drizzle path: a group goes through
 * `CARDINAL.models.groups.createGroupFromImport()` for its insert-then-`reloadCache()`, which a raw
 * insert would skip — an imported group's rules would not take effect until the next restart. */
export function createDrizzleWriter(db: WikiDb): UsersGroupsWriter {
  return {
    async insertGroup(row) {
      const id = await CARDINAL.models.groups.createGroupFromImport({
        name: row.name,
        permissions: (row.permissions ?? []) as string[],
        rules: (row.rules ?? []) as GroupRule[]
      })
      return { id }
    },
    async insertUser(row) {
      const [inserted] = await db.insert(usersTable).values(row).returning({ id: usersTable.id })
      return inserted
    },
    async insertUserGroup(userId, groupId) {
      await db.insert(userGroupsTable).values({ userId, groupId })
    },
    async assignUserToSystemGroup(userId, groupId) {
      await CARDINAL.models.groups.assignUserToGroup(groupId, userId)
    }
  }
}

/** Mints a placeholder UUID per record instead of writing anything, so the `userGroups` phase can
 * still resolve cross-references and report what it *would* write. */
export function createDryRunWriter(): UsersGroupsWriter {
  return {
    async insertGroup() {
      return { id: crypto.randomUUID() }
    },
    async insertUser() {
      return { id: crypto.randomUUID() }
    },
    async insertUserGroup() {
      // Nothing is written in a dry run.
    },
    async assignUserToSystemGroup() {
      // Nothing is written in a dry run.
    }
  }
}

/** `SourceConnector` has no `userGroups()` generator: membership is denormalized onto each user row
 * as `groups: [{id, name}]`, so the `userGroups` phase reads `users()` a second time (a fresh call
 * re-issues the query) and re-expands it here into one flat `{userId, groupId}` record per
 * membership, in source order. */
export async function* deriveUserGroupsFromEmbeddedGroups(
  users: AsyncIterable<SourceRecord>
): AsyncGenerator<SourceRecord> {
  for await (const user of users) {
    const userId = user.id
    const groups = Array.isArray(user.groups) ? user.groups : []
    for (const group of groups) {
      if (group && typeof group === 'object' && 'id' in group) {
        yield { userId, groupId: (group as { id: unknown }).id }
      }
    }
  }
}

/** `undefined` rather than a throw for a missing/non-numeric value, so a malformed record is
 * reported as `skipped` instead of aborting the whole entity's import. */
function readSourceId(source: SourceRecord, column: string): number | undefined {
  const raw = source[column]
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isInteger(n) ? n : undefined
}

/** Per-record import of one id-mapped entity (`groups` or `users`). `summary`/`idMap` are live
 * references mutated by every `importOne()` call, not snapshots. */
export interface RecordImporter {
  /** Returns the `RecordStatus` recorded onto `summary` for this record. `importOne()` never throws
   * for a bad or conflicting record, so the return value — not a caught exception — is the only
   * signal a caller routing its own `WriteRecorder` call has. */
  importOne(source: SourceRecord): Promise<RecordStatus>
  readonly summary: EntityImportSummary
  readonly idMap: Map<number, string>
}

export type GroupImporter = RecordImporter

/** `providerFallbacks` is the same kind of live reference as `summary`/`idMap`, accumulating across
 * every `importOne()` call. Only `users` produces them. */
export interface UserImporter extends RecordImporter {
  readonly providerFallbacks: ProviderFallbackFlag[]
}

interface RecordImporterOptions<TRow> {
  convert: (source: SourceRecord) => ConversionOutcome<TRow> | Promise<ConversionOutcome<TRow>>
  insert: (row: TRow) => Promise<{ id: string }>
  /** Recorded verbatim for a source row flagged `isSystem` — the one thing groups and users say
   * differently, since each names its own already-seeded 3.0 equivalent. */
  systemSkipMessage: string
  providerFallbacks?: ProviderFallbackFlag[]
}

/** Never throws for one bad or conflicting record; each becomes a `RecordResult` on `summary`
 * instead, so one record's bad data cannot abort the whole run. */
function createRecordImporter<TRow>(options: RecordImporterOptions<TRow>): RecordImporter {
  const summary = emptySummary()
  const idMap = new Map<number, string>()

  async function importOne(sourceRecord: SourceRecord): Promise<RecordStatus> {
    const sourceId = readSourceId(sourceRecord, 'id')
    if (sourceId === undefined) {
      record(summary, {
        sourceId: String(sourceRecord.id ?? '?'),
        status: 'skipped',
        message: 'missing or non-integer source id'
      })
      return 'skipped'
    }

    if (isSystemSourceRecord(sourceRecord)) {
      record(summary, { sourceId, status: 'skipped', message: options.systemSkipMessage })
      return 'skipped'
    }

    const outcome = await options.convert(sourceRecord)
    if (outcome.status !== 'created') {
      record(summary, { sourceId, status: outcome.status, message: outcome.message })
      return outcome.status
    }

    try {
      const { id: targetId } = await options.insert(outcome.row)
      idMap.set(sourceId, targetId)
      record(summary, { sourceId, targetId, status: 'created', message: outcome.message })
      if (outcome.providerFallback) {
        options.providerFallbacks?.push(outcome.providerFallback)
      }
      return 'created'
    } catch (err: any) {
      record(summary, { sourceId, status: 'conflicted', message: err.message })
      return 'conflicted'
    }
  }

  return { importOne, summary, idMap }
}

export function createGroupImporter(
  convert: GroupConverter,
  writer: UsersGroupsWriter
): GroupImporter {
  return createRecordImporter({
    convert,
    insert: (row) => writer.insertGroup(row),
    systemSkipMessage:
      "system group (Administrators/Guests) -- an equivalent is already seeded by this install's own Groups.init(); not imported"
  })
}

export function createUserImporter(
  convert: UserConverter,
  writer: UsersGroupsWriter
): UserImporter {
  const providerFallbacks: ProviderFallbackFlag[] = []
  const importer = createRecordImporter({
    convert,
    insert: (row) => writer.insertUser(row),
    systemSkipMessage:
      "system user (Administrator/Guest) -- an equivalent is already seeded by this install's own Users.init(); not imported",
    providerFallbacks
  })
  return { ...importer, providerFallbacks }
}

/** Same shape as `RecordImporter`, minus the id map: once both ids resolve there is nothing left to
 * convert, so this one takes no converter. */
export interface UserGroupImporter {
  importOne(source: SourceRecord): Promise<RecordStatus>
  readonly summary: EntityImportSummary
}

/** Takes the SAME `Map` instances `createGroupImporter()`/`createUserImporter()` populate, not
 * copies, so a membership resolved here reflects every group/user imported so far — including ones
 * imported after this importer was constructed.
 *
 * An unresolved `groupId` does not necessarily mean "the group was never created": it may be the
 * source's own system Administrators/Guests group, which `createGroupImporter()` deliberately skips.
 * With `systemGroupIds` supplied, that case alone is remapped onto this install's real group rather
 * than dropped. */
export function createUserGroupImporter(
  userIdMap: Map<number, string>,
  groupIdMap: Map<number, string>,
  writer: UsersGroupsWriter,
  systemGroupIds?: SystemGroupIds
): UserGroupImporter {
  const summary = emptySummary()

  async function importOne(sourceRecord: SourceRecord): Promise<RecordStatus> {
    const sourceUserId = readSourceId(sourceRecord, 'userId')
    const sourceGroupId = readSourceId(sourceRecord, 'groupId')
    const label = `${sourceRecord.userId ?? '?'}:${sourceRecord.groupId ?? '?'}`

    if (sourceUserId === undefined || sourceGroupId === undefined) {
      record(summary, {
        sourceId: label,
        status: 'skipped',
        message: 'missing or non-integer userId/groupId'
      })
      return 'skipped'
    }

    const targetUserId = userIdMap.get(sourceUserId)
    let targetGroupId = groupIdMap.get(sourceGroupId)
    let remappedToSystemGroup = false

    if (!targetGroupId && systemGroupIds) {
      if (sourceGroupId === SOURCE_SYSTEM_GROUP_ADMIN_ID) {
        targetGroupId = systemGroupIds.admin
        remappedToSystemGroup = true
      } else if (sourceGroupId === SOURCE_SYSTEM_GROUP_GUEST_ID) {
        targetGroupId = systemGroupIds.guest
        remappedToSystemGroup = true
      }
    }

    if (!targetUserId || !targetGroupId) {
      const missing =
        !targetUserId && !targetGroupId ? 'user and group' : !targetUserId ? 'user' : 'group'
      record(summary, {
        sourceId: `${sourceUserId}:${sourceGroupId}`,
        status: 'skipped',
        message: `referenced ${missing} was not created, so this membership was not written`
      })
      return 'skipped'
    }

    try {
      if (remappedToSystemGroup) {
        await writer.assignUserToSystemGroup(targetUserId, targetGroupId)
      } else {
        await writer.insertUserGroup(targetUserId, targetGroupId)
      }
      record(summary, {
        sourceId: `${sourceUserId}:${sourceGroupId}`,
        targetId: targetGroupId,
        status: 'created',
        message: remappedToSystemGroup
          ? `remapped from the source's system group ${sourceGroupId} onto this install's real system group, since the source row itself was not imported`
          : undefined
      })
      return 'created'
    } catch (err: any) {
      record(summary, {
        sourceId: `${sourceUserId}:${sourceGroupId}`,
        status: 'conflicted',
        message: err.message
      })
      return 'conflicted'
    }
  }

  return { importOne, summary }
}
