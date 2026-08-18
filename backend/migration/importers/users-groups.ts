import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'
import { v4 as uuid } from 'uuid'
import type { WikiDb } from '../../core/db.ts'
import {
  groups as groupsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../../db/schema.ts'
import type { GroupRule, GroupRuleMatch } from '../../models/groups.ts'
import type { SourceRecord } from '../connector.ts'

/**
 * Users/Groups importer engine (Feature 414, Task 726).
 *
 * Entry point for the part of the 2.5.x → 3.0 migration that writes `groups`, `users` and
 * `userGroups`. Deliberately outside both the request/response path (nothing here is a Fastify
 * route) and `checkForLegacyInstall()` (`core/db.ts`) — that function detects a legacy install
 * during normal boot, whereas this only ever runs when an administrator explicitly launches a
 * migration, which is feature #421's CLI. This module is that CLI's engine, not the CLI itself:
 * it exposes `importUsersAndGroups()` for the CLI to call once it has built a `SourceConnector`
 * and a `UsersGroupsWriter`; nothing here boots a database connection or parses argv.
 *
 * What this task builds:
 * - The three-phase write order (groups → users → userGroups) `importUsersAndGroups()` enforces.
 * - The `Map<number, string>` source-id → target-UUID bookkeeping both `groups` and `users` need,
 *   since 2.5.x uses integer PKs (`increments()`) and 3.0 uses `uuid().defaultRandom()`
 *   (`db/schema.ts` `groups` at line 147, `users` at line 767) — see `2.5x-to-3.0-mapping.md`'s
 *   `userGroups` section, which calls out that `userId`/`groupId` are "remapped through the
 *   [...] old-id → new-UUID table" and that 2.x's own `userGroups.id` has no destination at all
 *   (it's a composite-PK relation table in 3.0, `db/schema.ts` `userGroups` at line 791).
 * - The `UsersGroupsImportResult` shape feature #421's CLI and dry-run report consume.
 *
 * What this task deliberately stubs (real field mapping is a later task under Feature 414):
 * - `convertGroup` / `convertUser`: per-record 2.x row → 3.0 insertable row. The default exports
 *   (`stubConvertGroup`, `stubConvertUser`) flag every record instead of converting it — real
 *   conversion means folding `auth`/`meta`/`prefs` jsonb, resolving `providerKey` to an
 *   `authentication` row UUID, and converting `permissions`/`pageRules` into 3.0's `rules` shape,
 *   none of which belongs here per this task's own description.
 * - The `userGroups` translation itself needs no such stub: per the mapping doc, all it does is
 *   look up both remapped ids and write the join row, which is exactly what `importUsersAndGroups()`
 *   already has to do to satisfy the ordering requirement above. There is no per-record 2.x → 3.0
 *   *field* to convert once the two ids are resolved.
 *
 * Task 729 adds one real (non-stub) piece: `createProviderFallbackUserConverter()`, a `UserConverter`
 * for source users whose `providerKey` cannot become a real 3.0 provider-linked account on this
 * install — see that function's doc for the full routing rule. It creates the account through the
 * local strategy with a random, unusable password (`mustChangePwd: true` forced), the same shape
 * `loginWithProvider()` already establishes for a brand-new provider account
 * (`models/users.ts`, `password: nanoid(32)`), and appends one entry to
 * `UsersGroupsImportResult.providerFallbacks` per account it creates — the data feature #421's
 * dry-run report renders. It still isn't the full `convertUser` (that's `local`, plus real
 * github/google/oidc linking when a mapping resolves — both deferred, per this module's own stubs
 * above); a later task composes this with those into one real `convertUser`.
 *
 * Task 730 adds the real (non-stub) group converter: `createGroupConverter()`. It converts a
 * non-system source group's `pageRules` array into 3.0's `GroupRule` shape (`deny` -> `mode`, a fresh
 * `id`, a synthesized `name`, `sites: []`) and splits the source group's flat `permissions` array into
 * what actually belongs on 3.0's `groups.permissions` -- the closed seven-name global-permission list
 * (`manage:users`, `manage:groups`, `manage:navigation`, `manage:theme`, `manage:sites`,
 * `manage:system`, `access:admin`) -- versus entries that only ever gated page-rule effectiveness in
 * 2.x and have no 3.0 destination (3.0's rules alone govern page access). A source group's own
 * Administrators/Users/Guests (`isSystem: true`) are skipped outright: 3.0 seeds its own system groups
 * once, in `Groups.init()`. Like the provider-fallback converter above, this is exported but NOT wired
 * as the default `convertGroup` -- composing every real converter into one default is a later task.
 * Unlike groups conversion itself, `createDrizzleWriter()`'s `insertGroup()` IS changed by this task,
 * from a raw `db.insert(groupsTable)` to `WIKI.models.groups.createGroupFromImport()`, per the task's
 * own instruction to write groups through the model rather than a raw insert -- see that method's doc
 * in `models/groups.ts`.
 *
 * Task 731 adds system-row exclusion and admin/guest membership remapping:
 * - `importGroups()`/`importUsers()` now skip any source record flagged `isSystem: true` -- 2.5.x
 *   id 1 (Administrators)/id 2 (Guests) groups and id 1 (Administrator)/id 2 (Guest) users -- BEFORE
 *   calling `convert()` at all, regardless of which converter is plugged in. Every 3.0 install already
 *   seeds its own equivalents once (`Groups.init()`/`Users.init()`), so creating a second copy from the
 *   source would be a duplicate, not an import.
 * - Skipping those source rows must not also drop the *membership* they implied. `importUserGroups()`
 *   now takes an optional `systemGroupIds` (this install's real target admin/guest group ids): when an
 *   ordinary (non-system) imported user's source membership pointed at the source's system
 *   Administrators (id 1) or Guests (id 2) group -- which was skipped, so the normal groupIdMap lookup
 *   misses -- the row is remapped onto the supplied target id via the new `UsersGroupsWriter.
 *   assignUserToSystemGroup()` (backed by `Groups.assignUserToGroup()`) instead of being silently
 *   skipped. An ordinary group lookup that resolves normally is untouched by this fallback.
 * - Where those target ids actually live at runtime is worth flagging: the task description names
 *   `WIKI.data.systemIds.{groupAdminId,userAdminId,userGuestId}`, but tracing `core/config.ts`'s
 *   `initDbValues()` shows those three are only local variables inside that function, generated by
 *   `uuid()` and handed to each model's `init()` -- never written back onto `WIKI.data.systemIds`
 *   (which, per `base.yml`, only ever holds `localAuthId`/`guestsGroupId`/`usersGroupId`, the ids fixed
 *   at seed time). The admin group id is instead persisted by `Settings.init()` as
 *   `settings.auth.rootAdminGroupId` and reloaded onto `WIKI.config.auth.rootAdminGroupId`
 *   (`core/config.ts` `loadFromDb()`); the guest *group* id genuinely is on `WIKI.data.systemIds`, as
 *   `guestsGroupId` (not `groupGuestId`). This module still takes no `WIKI` dependency (same
 *   testability goal as `localStrategyId` above) -- the future #421 CLI is the caller that resolves
 *   `systemGroupIds` from those real locations before invoking `importUsersAndGroups()`.
 */

// ---------------------------------------------------------------------------
// Result shape — the contract feature #421's CLI and dry-run report read.
// ---------------------------------------------------------------------------

/** Outcome of attempting to write one source record. */
export type RecordStatus = 'created' | 'skipped' | 'conflicted' | 'flagged'

/** Per-record detail, always present regardless of outcome so a dry-run report can list every row. */
export interface RecordResult {
  /** The record's 2.x integer id (or, for a `userGroups` row lacking one of its own, a synthetic
   * `${userId}:${groupId}` label — see `2.5x-to-3.0-mapping.md`'s note that the join table's own
   * surrogate id has no destination). */
  sourceId: number | string
  /** The row's new UUID, when one was actually written (or would be, in a dry run). */
  targetId?: string
  status: RecordStatus
  /** Human-readable reason, required for every non-`created` status. */
  message?: string
}

/** Aggregate counts plus the per-record detail list for one entity (`groups`, `users`, or `userGroups`). */
export interface EntityImportSummary {
  created: number
  skipped: number
  conflicted: number
  flagged: number
  records: RecordResult[]
}

/** One entry per source user whose account was created through the unsupported/reconfigured-provider
 * local-strategy fallback (Task 729, `createProviderFallbackUserConverter`) — the data feature #421's
 * dry-run report renders so an administrator can see exactly which accounts need a password reset
 * before they're usable, without cross-referencing the per-record detail for each entity. */
export interface ProviderFallbackFlag {
  email: string
  sourceProvider: string
  reason: string
}

/** What `importUsersAndGroups()` resolves with — one summary per entity, in write order, plus the
 * cross-cutting provider-fallback report (see `ProviderFallbackFlag`). */
export interface UsersGroupsImportResult {
  groups: EntityImportSummary
  users: EntityImportSummary
  userGroups: EntityImportSummary
  providerFallbacks: ProviderFallbackFlag[]
}

/** True when a source record is flagged `isSystem` in 2.x -- a fixed row (the Administrators/Guests
 * groups, the Administrator/Guest users) that already exists in any 3.0 install, seeded once by
 * `Groups.init()`/`Users.init()`. Checked in orchestration, before any converter runs, so a system
 * row is never created regardless of which `GroupConverter`/`UserConverter` is plugged in -- Task 731. */
function isSystemSourceRecord(sourceRecord: SourceRecord): boolean {
  return readSourceBoolean(sourceRecord, 'isSystem') === true
}

/** 2.5.x's fixed source id for the Administrators group -- see `docs/migration/2.5x-source-schema.md`
 * and this task's own description. Used only to recognize a `userGroups` row whose `groupId` pointed
 * at the source's system Administrators group, since that group's row itself was skipped (Task 731)
 * and so never gets an entry in the group id map. */
const SOURCE_SYSTEM_GROUP_ADMIN_ID = 1

/** 2.5.x's fixed source id for the Guests group -- same rationale as `SOURCE_SYSTEM_GROUP_ADMIN_ID`. */
const SOURCE_SYSTEM_GROUP_GUEST_ID = 2

/** This install's real target ids for the system Administrators/Guests groups, supplied by the caller
 * so `importUserGroups()` can remap a membership that pointed at the *source's* now-skipped system
 * group onto the equivalent that already exists here -- see the module doc's Task 731 paragraph for
 * where these ids actually live at runtime. */
export interface SystemGroupIds {
  admin: string
  guest: string
}

function emptySummary(): EntityImportSummary {
  return { created: 0, skipped: 0, conflicted: 0, flagged: 0, records: [] }
}

function record(summary: EntityImportSummary, result: RecordResult): void {
  summary[result.status]++
  summary.records.push(result)
}

// ---------------------------------------------------------------------------
// Per-record conversion — stubbed here, real bodies land in a later Feature 414 task.
// ---------------------------------------------------------------------------

/** What `groupsTable`/`usersTable` actually accept on insert — the shape a real converter must
 * eventually produce; this task only needs the type to thread through the stub signatures below. */
export type NewGroupRow = typeof groupsTable.$inferInsert
export type NewUserRow = typeof usersTable.$inferInsert

/** A conversion either produces an insertable row, or explains why it doesn't. `providerFallback` is
 * only ever set by `createProviderFallbackUserConverter()` (Task 729): a created row that also needs
 * to land on `UsersGroupsImportResult.providerFallbacks`, since the account genuinely gets created
 * and is *also* flagged for admin attention — not one or the other. */
export type ConversionOutcome<TRow> =
  | {
      status: 'created'
      row: TRow
      providerFallback?: ProviderFallbackFlag
      /** Optional note for an otherwise-successful conversion — e.g. `createGroupConverter()` uses
       * this to report permissions/rules that were dropped during conversion rather than silently
       * discarding them. Never required: most converters that reach `created` have nothing to add. */
      message?: string
    }
  | { status: 'skipped' | 'conflicted' | 'flagged'; message: string }

export type GroupConverter = (
  source: SourceRecord
) => ConversionOutcome<NewGroupRow> | Promise<ConversionOutcome<NewGroupRow>>

export type UserConverter = (
  source: SourceRecord
) => ConversionOutcome<NewUserRow> | Promise<ConversionOutcome<NewUserRow>>

/** Deferred to a later Feature 414 task — see the module doc's "deliberately stubs" section. */
export const stubConvertGroup: GroupConverter = () => ({
  status: 'flagged',
  message: 'group field mapping not implemented yet (deferred to a later Feature 414 task)'
})

/** Deferred to a later Feature 414 task — see the module doc's "deliberately stubs" section. */
export const stubConvertUser: UserConverter = () => ({
  status: 'flagged',
  message: 'user field mapping not implemented yet (deferred to a later Feature 414 task)'
})

// ---------------------------------------------------------------------------
// Group conversion (Task 730) — the one real (non-stub) piece of group conversion this task adds:
// pageRules -> rules reshaping and the permissions/global-vs-page-rule-only split. See the module
// doc's Task 730 paragraph and `docs/migration/2.5x-to-3.0-mapping.md`'s `groups` section.
// ---------------------------------------------------------------------------

/** The closed seven-name global-permission list documented in this repo's `CLAUDE.md` — the only
 * strings 3.0's `groups.permissions` column may hold. Everything else a 2.x source group's flat
 * `permissions` array might contain (`read:pages`, `write:pages`, …) only ever gated whether that
 * group's page rules took effect at all in 2.x — 3.0 has no equivalent global gate; the rules alone
 * govern page access — so those entries are dropped rather than carried into `groups.permissions`. */
const GLOBAL_PERMISSIONS = new Set([
  'manage:users',
  'manage:groups',
  'manage:navigation',
  'manage:theme',
  'manage:sites',
  'manage:system',
  'access:admin'
])

/** The five `match` values 2.x's `PageRule.match` enum actually has (`server/graph/schemas/group.graphql`
 * @ `requarks/wiki`). 3.0's sixth value, `TAGALL`, has no 2.x source to map from, so a rule claiming it
 * (or anything else) is treated as malformed rather than guessed at. */
const VALID_2X_RULE_MATCH = new Set(['START', 'END', 'REGEX', 'TAG', 'EXACT'])

/** Reads a boolean column off a source record. */
function readSourceBoolean(source: SourceRecord, column: string): boolean | undefined {
  const raw = source[column]
  return typeof raw === 'boolean' ? raw : undefined
}

/** Narrows an arbitrary value to a string array, dropping any non-string element rather than
 * throwing — a defensively-read 2.x jsonb column may contain anything. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/** A synthesized label for an imported rule, since 2.x rules carry no `name` of their own — e.g.
 * `Imported Rule 2: START blog/` when the rule addresses a path, or plain `Imported Rule 2` for a
 * rule with an empty path (2.x's convention for "the whole site"). */
function synthesizeRuleName(rule: { match: string; path: string }, index: number): string {
  return rule.path
    ? `Imported Rule ${index + 1}: ${rule.match} ${rule.path}`
    : `Imported Rule ${index + 1}`
}

/**
 * Converts one 2.x `pageRules[]` element into 3.0's `GroupRule` shape, or `undefined` if the source
 * element is too malformed to convert (missing `deny`, or a `match` outside 2.x's own five-value
 * enum) — the caller drops such an element and counts it rather than failing the whole group.
 *
 * - `deny: true` -> `mode: 'DENY'`; `deny: false` -> `mode: 'ALLOW'`. `mode: 'FORCEALLOW'` is never
 *   produced — 2.x has no concept a force-allow rule could come from.
 * - `id` is always freshly generated: a 2.x rule id has no cross-table reference depending on it.
 * - `sites` is always `[]`: 2.x predates multi-site, so an imported rule applies on every site, which
 *   is the only site there was.
 * - `name` is synthesized (`synthesizeRuleName`), since 2.x rules carry none.
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
  const path = typeof source.path === 'string' ? source.path : ''

  return {
    id: uuid(),
    name: synthesizeRuleName({ match, path }, index),
    roles: asStringArray(source.roles),
    match,
    mode: deny ? 'DENY' : 'ALLOW',
    path,
    locales: asStringArray(source.locales),
    sites: []
  }
}

/**
 * Builds the real (non-stub) `GroupConverter` for Task 730.
 *
 * A source group flagged `isSystem` is skipped outright: 3.0 seeds its own Administrators/Users/
 * Guests once, in `Groups.init()`, with fixed system ids nothing else may collide with — a 2.x
 * source's own system groups have no destination to import into.
 *
 * Otherwise, the source group's `permissions` array is split against `GLOBAL_PERMISSIONS`: entries in
 * the closed list are carried onto `groups.permissions`; everything else (2.x page-permission strings
 * that only ever gated page-rule effectiveness, with no 3.0 equivalent) is dropped. The source group's
 * `pageRules` array is converted element-by-element by `convertPageRule()`; a malformed element is
 * dropped rather than failing the whole group. When anything was dropped, the outcome's `message`
 * says what and how many — an otherwise-successful `created` conversion, not a failure.
 */
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

// ---------------------------------------------------------------------------
// Provider fallback (Task 729) — the one non-stub piece of user conversion this task adds. Every
// other providerKey (`local`, or a mapped github/google/oidc) is out of scope here; see the module
// doc and `needsProviderFallback()` below.
// ---------------------------------------------------------------------------

/** 2.x `providerKey` values that correspond to a 3.0 authentication module that actually exists
 * today — `backend/modules/authentication/{local,github,google,oidc}/` is the full list. Membership
 * here is necessary but not sufficient for a real provider-linked import: see
 * `needsProviderFallback()`. */
const IMPLEMENTED_PROVIDER_MODULES = new Set(['local', 'github', 'google', 'oidc'])

/**
 * Whether a source user's `providerKey` must be routed through the unsupported/reconfigured-provider
 * local-strategy fallback, rather than a real provider-linked (or local-password-carryover) import.
 *
 * - `local` never falls back here — a local password carries over through `Users.importLocalUser()`
 *   (Task 728), a different path entirely, not this one.
 * - Every other `providerKey` falls back UNLESS `strategyMapping` names a target strategy id for it.
 *   This covers both halves of the task deliberately: a 2.x provider with no 3.0 module at all (LDAP,
 *   SAML, CAS, Auth0, Okta, ... — Epic #333's territory) has nowhere else to go, and a 2.x
 *   `github`/`google`/`oidc` account has nowhere *safe* to go either — 3.0 keys `auth` by
 *   strategy-instance UUID, and a fresh 3.0 install's same-module strategy (if configured at all)
 *   will not share the source's client id/secret, so the linked external account id cannot be
 *   assumed to resolve to anything on this install. A caller that has actually verified the mapping
 *   (an administrator who reconfigured the equivalent strategy and knows its new id) opts out per
 *   source module by supplying it here; real conversion for a mapped entry is not this function's
 *   job — see the module doc.
 */
export function needsProviderFallback(
  providerKey: string,
  strategyMapping: Record<string, string> = {}
): boolean {
  if (providerKey === 'local') return false
  return !(providerKey in strategyMapping)
}

function providerFallbackReason(providerKey: string): string {
  return IMPLEMENTED_PROVIDER_MODULES.has(providerKey)
    ? `source provider '${providerKey}' is implemented in 3.0, but no target-strategy mapping was supplied for it — a fresh install's ${providerKey} strategy (if configured at all) would not share the source's client id/secret, so the linked account cannot be assumed to resolve on this install`
    : `source provider '${providerKey}' has no 3.0-native implementation (local/github/google/oidc is the full list — see Epic #333)`
}

/** Reads a string column, treating an empty string the same as absent so a blank source field is
 * reported rather than silently accepted. */
function readSourceString(source: SourceRecord, column: string): string | undefined {
  const raw = source[column]
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

export interface ProviderFallbackConverterOptions {
  /** Target UUID of this install's local authentication strategy. The engine deliberately has no
   * `WIKI` dependency (see the module doc's testability goal), so the caller — the future #421 CLI —
   * supplies this from `WIKI.data.systemIds.localAuthId` at runtime. */
  localStrategyId: string
  /** Source-module -> target-strategy-id mapping the caller explicitly verified, e.g.
   * `{ github: '<uuid-of-a-freshly-configured-github-strategy>' }`. A source module with no entry
   * here always falls back. Defaults to empty (every non-`local` provider falls back). */
  strategyMapping?: Record<string, string>
}

/**
 * Builds the `UserConverter` for the unsupported/reconfigured-provider fallback path (Task 729).
 *
 * For a source user whose `providerKey` needs `needsProviderFallback()`, this creates the account
 * through the local strategy with the same "provider-authenticated, no usable local password" shape
 * `loginWithProvider()` already establishes for a brand-new provider account (`models/users.ts`,
 * `password: nanoid(32)`) — except `mustChangePwd` is forced `true`, since (unlike a fresh
 * provider-authenticated signup) this account has no working sign-in path on this install at all
 * until an administrator resets it. Every account this converter actually creates also gets one
 * `ProviderFallbackFlag` entry (source email, source provider, reason) on the outcome, which
 * `importUsersAndGroups()` collects onto `UsersGroupsImportResult.providerFallbacks`.
 *
 * A `local` source user, or one whose provider resolves through `strategyMapping`, is NOT this
 * converter's job — both return `flagged` (not `skipped`: the record is real and needs handling, just
 * not by this converter) rather than being silently passed through, so a caller relying solely on
 * this converter still sees every record accounted for.
 */
export function createProviderFallbackUserConverter(
  options: ProviderFallbackConverterOptions
): UserConverter {
  const strategyMapping = options.strategyMapping ?? {}

  return async (source) => {
    const providerKey = readSourceString(source, 'providerKey')
    if (providerKey === undefined) {
      return {
        status: 'flagged',
        message: 'source user record has no providerKey; cannot determine provider routing'
      }
    }

    if (!needsProviderFallback(providerKey, strategyMapping)) {
      return {
        status: 'flagged',
        message: `source provider '${providerKey}' is not handled by the provider-fallback converter (either 'local' — see Users.importLocalUser, Task 728 — or explicitly mapped by the caller); real conversion is deferred to a later Feature 414 task`
      }
    }

    const email = readSourceString(source, 'email')?.toLowerCase()
    if (!email) {
      return { status: 'skipped', message: 'source user record has no email address' }
    }
    const name = readSourceString(source, 'name') ?? email

    const row: NewUserRow = {
      email,
      name,
      auth: {
        [options.localStrategyId]: {
          // -> Same "provider-authenticated, no usable local password" shape loginWithProvider()
          //    establishes for a brand-new provider account, except mustChangePwd is forced true: this
          //    account cannot sign in through its source provider on this install (see
          //    needsProviderFallback above), so it must go through a password reset before use.
          password: await bcrypt.hash(nanoid(32), 12),
          mustChangePwd: true,
          restrictLogin: false,
          tfaIsActive: false,
          tfaRequired: false,
          tfaSecret: ''
        }
      },
      isSystem: false,
      isActive: true,
      isVerified: true,
      meta: { location: '', jobTitle: '', pronouns: '' },
      prefs: {
        timezone: 'America/New_York',
        dateFormat: 'YYYY-MM-DD',
        timeFormat: '12h',
        appearance: 'site',
        cvd: 'none'
      }
    }

    return {
      status: 'created',
      row,
      providerFallback: {
        email,
        sourceProvider: providerKey,
        reason: providerFallbackReason(providerKey)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Write port — lets orchestration be unit-tested without a live database, and lets the CLI (#421)
// swap in a dry-run writer that never touches Postgres at all.
// ---------------------------------------------------------------------------

export interface UsersGroupsWriter {
  insertGroup(row: NewGroupRow): Promise<{ id: string }>
  insertUser(row: NewUserRow): Promise<{ id: string }>
  insertUserGroup(userId: string, groupId: string): Promise<void>
  /** Assigns a user to one of THIS install's real system groups (Administrators/Guests) -- used only
   * by the Task 731 remap path in `importUserGroups()`, never for an ordinary imported group. Distinct
   * from `insertUserGroup()` because the real writer must go through `Groups.assignUserToGroup()`
   * rather than a raw insert: that model method runs `guestMembershipViolation()` and de-duplicates via
   * `onConflictDoNothing()`, both of which matter for a system group in a way they don't for a fresh,
   * just-created ordinary group. */
  assignUserToSystemGroup(userId: string, groupId: string): Promise<void>
}

/** Real writer, backed by Drizzle. Any insert failure (e.g. `users.email`'s unique constraint) is
 * surfaced to the caller as a thrown error — `importUsersAndGroups()` catches it per-record and
 * downgrades that record to `conflicted` rather than aborting the whole import.
 *
 * `insertGroup()` is the one exception to "backed by Drizzle": per Task 730, a group is written
 * through `WIKI.models.groups.createGroupFromImport()` rather than a raw `db.insert(groupsTable)` —
 * that model method carries `createGroup()`'s own insert-then-`reloadCache()` shape, which a bare
 * insert here would silently skip (a newly-imported group's rules would not take effect until the
 * next process restart). `insertUser()`/`insertUserGroup()` stay raw inserts; routing those through
 * their own models is not this task's scope. */
export function createDrizzleWriter(db: WikiDb): UsersGroupsWriter {
  return {
    async insertGroup(row) {
      const id = await WIKI.models.groups.createGroupFromImport({
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
      await WIKI.models.groups.assignUserToGroup(groupId, userId)
    }
  }
}

/** Dry-run writer: mints a placeholder UUID for every record instead of writing anything, so the
 * `userGroups` phase can still resolve cross-references and report what it *would* write. */
export function createDryRunWriter(): UsersGroupsWriter {
  return {
    async insertGroup() {
      return { id: crypto.randomUUID() }
    },
    async insertUser() {
      return { id: crypto.randomUUID() }
    },
    async insertUserGroup() {
      // Nothing to return — a dry run never needs the join row's identity for anything downstream.
    },
    async assignUserToSystemGroup() {
      // Same rationale as insertUserGroup() above -- nothing is actually written in a dry run.
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export interface UsersGroupsImportInput {
  source: {
    groups: AsyncIterable<SourceRecord>
    users: AsyncIterable<SourceRecord>
    /** `userGroups` join rows — see the module doc for why this is a third iterable rather than
     * membership denormalized onto each user record: the source connector interface (#412) exposes
     * only `users()`/`groups()`, so whichever later task implements those bodies is free to hand
     * this engine a `userGroups` iterable built any way it likes, without this orchestration layer
     * having to assume a particular shape for embedded membership. */
    userGroups: AsyncIterable<SourceRecord>
  }
  writer: UsersGroupsWriter
  convertGroup?: GroupConverter
  convertUser?: UserConverter
  /** This install's real target admin/guest group ids, for the Task 731 membership-remap fallback in
   * `importUserGroups()`. Omitted entirely, a membership that pointed at the source's system group
   * falls back to the pre-731 behavior of being reported `skipped` -- see the module doc's Task 731
   * paragraph for where the future #421 CLI actually sources these two ids from at runtime. */
  systemGroupIds?: SystemGroupIds
}

/** Reads a 2.x integer id off a source record, under the given column name. Returns `undefined`
 * (rather than throwing) for a missing/non-numeric value so a malformed record can be reported as
 * `skipped` instead of aborting the whole entity's import. */
function readSourceId(source: SourceRecord, column: string): number | undefined {
  const raw = source[column]
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isInteger(n) ? n : undefined
}

async function importGroups(
  source: AsyncIterable<SourceRecord>,
  convert: GroupConverter,
  writer: UsersGroupsWriter
): Promise<{ summary: EntityImportSummary; idMap: Map<number, string> }> {
  const summary = emptySummary()
  const idMap = new Map<number, string>()

  for await (const sourceRecord of source) {
    const sourceId = readSourceId(sourceRecord, 'id')
    if (sourceId === undefined) {
      record(summary, {
        sourceId: String(sourceRecord.id ?? '?'),
        status: 'skipped',
        message: 'missing or non-integer source id'
      })
      continue
    }

    if (isSystemSourceRecord(sourceRecord)) {
      record(summary, {
        sourceId,
        status: 'skipped',
        message:
          "system group (Administrators/Guests) -- an equivalent is already seeded by this install's own Groups.init(); not imported"
      })
      continue
    }

    const outcome = await convert(sourceRecord)
    if (outcome.status !== 'created') {
      record(summary, { sourceId, status: outcome.status, message: outcome.message })
      continue
    }

    try {
      const { id: targetId } = await writer.insertGroup(outcome.row)
      idMap.set(sourceId, targetId)
      record(summary, { sourceId, targetId, status: 'created', message: outcome.message })
    } catch (err: any) {
      record(summary, { sourceId, status: 'conflicted', message: err.message })
    }
  }

  return { summary, idMap }
}

async function importUsers(
  source: AsyncIterable<SourceRecord>,
  convert: UserConverter,
  writer: UsersGroupsWriter
): Promise<{
  summary: EntityImportSummary
  idMap: Map<number, string>
  providerFallbacks: ProviderFallbackFlag[]
}> {
  const summary = emptySummary()
  const idMap = new Map<number, string>()
  const providerFallbacks: ProviderFallbackFlag[] = []

  for await (const sourceRecord of source) {
    const sourceId = readSourceId(sourceRecord, 'id')
    if (sourceId === undefined) {
      record(summary, {
        sourceId: String(sourceRecord.id ?? '?'),
        status: 'skipped',
        message: 'missing or non-integer source id'
      })
      continue
    }

    if (isSystemSourceRecord(sourceRecord)) {
      record(summary, {
        sourceId,
        status: 'skipped',
        message:
          "system user (Administrator/Guest) -- an equivalent is already seeded by this install's own Users.init(); not imported"
      })
      continue
    }

    const outcome = await convert(sourceRecord)
    if (outcome.status !== 'created') {
      record(summary, { sourceId, status: outcome.status, message: outcome.message })
      continue
    }

    try {
      const { id: targetId } = await writer.insertUser(outcome.row)
      idMap.set(sourceId, targetId)
      record(summary, { sourceId, targetId, status: 'created' })
      if (outcome.providerFallback) {
        providerFallbacks.push(outcome.providerFallback)
      }
    } catch (err: any) {
      record(summary, { sourceId, status: 'conflicted', message: err.message })
    }
  }

  return { summary, idMap, providerFallbacks }
}

/** Translates and writes `userGroups` join rows, strictly after both id maps are fully populated —
 * the ordering `importUsersAndGroups()` exists to guarantee. No field-mapping stub is needed here (see
 * the module doc): once both ids resolve, there is nothing left to convert.
 *
 * Task 731: a `groupId` that doesn't resolve in `groupIdMap` is not automatically "the group was
 * never created" -- it may be the source's own system Administrators (`SOURCE_SYSTEM_GROUP_ADMIN_ID`)
 * or Guests (`SOURCE_SYSTEM_GROUP_GUEST_ID`) group, which `importGroups()` deliberately skips rather
 * than creates. When `systemGroupIds` is supplied, that specific case is remapped onto this install's
 * real target group via `writer.assignUserToSystemGroup()` instead of being dropped. An ordinary group
 * id that resolves normally through `groupIdMap` never reaches this fallback at all. */
async function importUserGroups(
  source: AsyncIterable<SourceRecord>,
  userIdMap: Map<number, string>,
  groupIdMap: Map<number, string>,
  writer: UsersGroupsWriter,
  systemGroupIds?: SystemGroupIds
): Promise<EntityImportSummary> {
  const summary = emptySummary()

  for await (const sourceRecord of source) {
    const sourceUserId = readSourceId(sourceRecord, 'userId')
    const sourceGroupId = readSourceId(sourceRecord, 'groupId')
    const label = `${sourceRecord.userId ?? '?'}:${sourceRecord.groupId ?? '?'}`

    if (sourceUserId === undefined || sourceGroupId === undefined) {
      record(summary, {
        sourceId: label,
        status: 'skipped',
        message: 'missing or non-integer userId/groupId'
      })
      continue
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
      continue
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
    } catch (err: any) {
      record(summary, {
        sourceId: `${sourceUserId}:${sourceGroupId}`,
        status: 'conflicted',
        message: err.message
      })
    }
  }

  return summary
}

/**
 * Runs the full Users/Groups import: groups, then users, then `userGroups` — in that order, and
 * only that order, because `userGroups` translation needs both id maps fully built first (a group
 * referenced by a not-yet-imported user, or vice versa, is impossible by construction here since
 * neither map is read until its own phase has completely finished).
 */
export async function importUsersAndGroups(
  input: UsersGroupsImportInput
): Promise<UsersGroupsImportResult> {
  const convertGroup = input.convertGroup ?? stubConvertGroup
  const convertUser = input.convertUser ?? stubConvertUser

  const groupsResult = await importGroups(input.source.groups, convertGroup, input.writer)
  const usersResult = await importUsers(input.source.users, convertUser, input.writer)
  const userGroupsSummary = await importUserGroups(
    input.source.userGroups,
    usersResult.idMap,
    groupsResult.idMap,
    input.writer,
    input.systemGroupIds
  )

  return {
    groups: groupsResult.summary,
    users: usersResult.summary,
    userGroups: userGroupsSummary,
    providerFallbacks: usersResult.providerFallbacks
  }
}
