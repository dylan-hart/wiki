import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'
import crypto from 'node:crypto'
import type { WikiDb } from '../../core/db.ts'
import {
  groups as groupsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../../db/schema.ts'
import { BCRYPT_ROUNDS } from '../../helpers/common.ts'
import type { GroupRule, GroupRuleMatch } from '../../models/groups.ts'
import type { SourceRecord } from '../connector.ts'
import { coerceSourceBoolean } from '../source-coercion.ts'
import { KNOWN_3_0_AUTH_MODULES } from '../report.ts'

/**
 * Users/Groups importer engine (Feature 414, Task 726).
 *
 * Entry point for the part of the 2.5.x → 3.0 migration that writes `groups`, `users` and
 * `userGroups`. Deliberately outside both the request/response path (nothing here is a Fastify
 * route) and `checkForLegacyInstall()` (`core/db.ts`) — that function detects a legacy install
 * during normal boot, whereas this only ever runs when an administrator explicitly launches a
 * migration, which is feature #421's CLI. This module is that CLI's engine, not the CLI itself:
 * it exposes one per-record importer factory per entity for the phase wiring to drive once it has
 * built a `SourceConnector` and a `UsersGroupsWriter`; nothing here boots a database connection or
 * parses argv.
 *
 * What this task builds:
 * - The three-phase write order (groups → users → userGroups) `phases/users.ts` enforces.
 * - The `Map<number, string>` source-id → target-UUID bookkeeping both `groups` and `users` need,
 *   since 2.5.x uses integer PKs (`increments()`) and 3.0 uses `uuid().defaultRandom()`
 *   (`db/schema.ts` `groups` at line 147, `users` at line 767) — see `2.5x-to-3.0-mapping.md`'s
 *   `userGroups` section, which calls out that `userId`/`groupId` are "remapped through the
 *   [...] old-id → new-UUID table" and that 2.x's own `userGroups.id` has no destination at all
 *   (it's a composite-PK relation table in 3.0, `db/schema.ts` `userGroups` at line 791).
 * - The `EntityImportSummary`/`ProviderFallbackFlag` shapes feature #421's CLI and dry-run report
 *   consume.
 *
 * `convertGroup`/`convertUser` — the per-record 2.x row → 3.0 insertable row conversion — are
 * supplied by the caller rather than owned here; `phases/users.ts` wires the real ones
 * (`createGroupConverter()`, `createLocalUserConverter()` and
 * `createProviderFallbackUserConverter()` below, composed by `composeUserConverters()`). The `userGroups` translation needs no converter at all:
 * per the mapping doc, all it does is look up both remapped ids and write the join row. There is no
 * per-record 2.x → 3.0 *field* to convert once the two ids are resolved.
 *
 * Task 729 adds one real (non-stub) piece: `createProviderFallbackUserConverter()`, a `UserConverter`
 * for source users whose `providerKey` cannot become a real 3.0 provider-linked account on this
 * install — see that function's doc for the full routing rule. It creates the account through the
 * local strategy with a random, unusable password (`mustChangePwd: true` forced), the same shape
 * `loginWithProvider()` already establishes for a brand-new provider account
 * (`models/users.ts`, `password: nanoid(32)`), and appends one entry to
 * `UserImporter.providerFallbacks` per account it creates — the data feature #421's dry-run report
 * renders.
 *
 * Task 730 adds the real (non-stub) group converter: `createGroupConverter()`. It converts a
 * non-system source group's `pageRules` array into 3.0's `GroupRule` shape (`deny` -> `mode`, a fresh
 * `id`, a synthesized `name`, `sites: []`) and splits the source group's flat `permissions` array into
 * what actually belongs on 3.0's `groups.permissions` -- the closed seven-name global-permission list
 * (`manage:users`, `manage:groups`, `manage:navigation`, `manage:theme`, `manage:sites`,
 * `manage:system`, `access:admin`) -- versus entries that only ever gated page-rule effectiveness in
 * 2.x and have no 3.0 destination (3.0's rules alone govern page access). A source group's own
 * Administrators/Users/Guests (`isSystem: true`) are skipped outright: 3.0 seeds its own system groups
 * once, in `Groups.init()`.
 * Unlike groups conversion itself, `createDrizzleWriter()`'s `insertGroup()` IS changed by this task,
 * from a raw `db.insert(groupsTable)` to `WIKI.models.groups.createGroupFromImport()`, per the task's
 * own instruction to write groups through the model rather than a raw insert -- see that method's doc
 * in `models/groups.ts`.
 *
 * Task 731 adds system-row exclusion and admin/guest membership remapping:
 * - `createGroupImporter()`'s/`createUserImporter()`'s `importOne()` now skip any source record
 *   flagged `isSystem: true` -- 2.5.x id 1 (Administrators)/id 2 (Guests) groups and id 1
 *   (Administrator)/id 2 (Guest) users -- BEFORE calling `convert()` at all, regardless of which
 *   converter is plugged in. Every 3.0 install already seeds its own equivalents once
 *   (`Groups.init()`/`Users.init()`), so creating a second copy from the source would be a
 *   duplicate, not an import.
 * - Skipping those source rows must not also drop the *membership* they implied.
 *   `createUserGroupImporter()` now takes an optional `systemGroupIds` (this install's real target
 *   admin/guest group ids): when an
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
 *   `systemGroupIds` from those real locations before building the importers.
 *
 * Re-run safety was deliberately dropped (design spec 2026-09-01): this engine only ever runs once
 * against a single fresh, empty destination, so there is no "already imported" case for
 * insertGroup()/insertUser() to detect — an insert failure (e.g. a genuine users.email collision from
 * malformed source data) is still caught and reported as 'conflicted', which is ordinary error
 * handling, not idempotency.
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
 * so `createUserGroupImporter()` can remap a membership that pointed at the *source's* now-skipped
 * system group onto the equivalent that already exists here -- see the module doc's Task 731
 * paragraph for where these ids actually live at runtime. */
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

// ---------------------------------------------------------------------------
// Per-record conversion — the caller supplies the converters; see the module doc.
// ---------------------------------------------------------------------------

/** What `groupsTable`/`usersTable` actually accept on insert — the shape a converter produces. */
export type NewGroupRow = typeof groupsTable.$inferInsert
export type NewUserRow = typeof usersTable.$inferInsert

/** A conversion either produces an insertable row, or explains why it doesn't. `providerFallback` is
 * only ever set by `createProviderFallbackUserConverter()` (Task 729): a created row that also needs
 * to land on `UserImporter.providerFallbacks`, since the account genuinely gets created
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

// ---------------------------------------------------------------------------
// Group conversion (Task 730) — the one real (non-stub) piece of group conversion this task adds:
// pageRules -> rules reshaping and the permissions/global-vs-page-rule-only split. See the module
// doc's Task 730 paragraph and `docs/migration/2.5x-to-3.0-mapping.md`'s `groups` section.
// ---------------------------------------------------------------------------

/** The closed global-permission list documented in this repo's `CLAUDE.md` — the only strings 3.0's
 * `groups.permissions` column may hold. Everything else a 2.x source group's flat `permissions` array
 * might contain (`read:pages`, `write:pages`, …) only ever gated whether that group's page rules took
 * effect at all in 2.x — 3.0 has no equivalent global gate; the rules alone govern page access — so
 * those entries are dropped rather than carried into `groups.permissions`. `manage:glossary` has no
 * 2.x source concept to map from (the glossary feature is 3.0-only), so it is never a legacy source
 * value and is intentionally absent here — this set filters what a 2.x export could actually contain,
 * not the full current vocabulary. */
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

/** Reads a boolean column off a source record — see `coerceSourceBoolean` for the cross-engine
 * representations this accepts (the export-bundle path can carry integer 0/1 as well as a real
 * boolean). */
function readSourceBoolean(source: SourceRecord, column: string): boolean | undefined {
  return coerceSourceBoolean(source[column])
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
    id: crypto.randomUUID(),
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
 * today — `../unmappable.ts`'s `KNOWN_3_0_AUTH_MODULES` (`backend/modules/authentication/*`,
 * cross-checked live against disk by that module's test), reused here rather than duplicated so the
 * two lists can't drift apart again. Membership here is necessary but not sufficient for a real
 * provider-linked import: see `needsProviderFallback()`. */
const IMPLEMENTED_PROVIDER_MODULES = KNOWN_3_0_AUTH_MODULES

/**
 * Whether a source user's `providerKey` must be routed through the unsupported/reconfigured-provider
 * local-strategy fallback, rather than a real provider-linked (or local-password-carryover) import.
 *
 * - `local` never falls back here — a local password carries over through `Users.importLocalUser()`
 *   (Task 728), a different path entirely, not this one.
 * - Every other `providerKey` falls back. This covers both halves of the task deliberately: a 2.x
 *   provider with no 3.0 module at all (LDAP, SAML, CAS, Auth0, Okta, ... — Epic #333's territory)
 *   has nowhere else to go, and a 2.x `github`/`google`/`oidc` account has nowhere *safe* to go
 *   either — 3.0 keys `auth` by strategy-instance UUID, and a fresh 3.0 install's same-module
 *   strategy (if configured at all) will not share the source's client id/secret, so the linked
 *   external account id cannot be assumed to resolve to anything on this install.
 */
export function needsProviderFallback(providerKey: string): boolean {
  return providerKey !== 'local'
}

function providerFallbackReason(providerKey: string): string {
  return IMPLEMENTED_PROVIDER_MODULES.has(providerKey)
    ? `source provider '${providerKey}' is implemented in 3.0, but a fresh install's ${providerKey} strategy (if configured at all) would not share the source's client id/secret, so the linked account cannot be assumed to resolve on this install`
    : `source provider '${providerKey}' has no 3.0-native implementation (see backend/modules/authentication/ and docs/migration/2.5x-settings-auth-storage-field-mapping.md's Part 2 provider inventory for the confirmed no-destination providers)`
}

/** Reads a string column, treating an empty string the same as absent so a blank source field is
 * reported rather than silently accepted. */
function readSourceString(source: SourceRecord, column: string): string | undefined {
  const raw = source[column]
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/** Reads a timestamp column off a source record. A live `PostgresSourceConnector` hands back a real
 * `Date` (node-postgres's own decoding of a `timestamp` column); a bundle/JSON-backed connector may
 * instead hand back an ISO string. Either is accepted; anything else (missing column, `null`,
 * malformed string) degrades to `undefined` — the same "let the target column default rather than
 * fail the whole record" tolerance `page-import.ts`'s `normalizeStagedDate` gives a malformed staged
 * date — so one bad timestamp on one source row never blocks that user's import. */
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

export interface ProviderFallbackConverterOptions {
  /** Target UUID of this install's local authentication strategy. The engine deliberately has no
   * `WIKI` dependency (see the module doc's testability goal), so the caller — the future #421 CLI —
   * supplies this from `WIKI.data.systemIds.localAuthId` at runtime. */
  localStrategyId: string
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
 * `createUserImporter()` collects onto `UserImporter.providerFallbacks`.
 *
 * A `local` source user is NOT this converter's job — it returns `flagged` (not `skipped`: the record
 * is real and needs handling, just not by this converter) rather than being silently passed through,
 * so a caller relying solely on this converter still sees every record accounted for.
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
        message: `source provider '${providerKey}' is not handled by the provider-fallback converter ('local' — see Users.importLocalUser, Task 728)`
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
          password: await bcrypt.hash(nanoid(32), BCRYPT_ROUNDS),
          mustChangePwd: true,
          restrictLogin: false,
          tfaIsActive: false,
          tfaRequired: false,
          tfaSecret: ''
        }
      },
      isSystem: false,
      // -> Read off the source, never assumed — an account an administrator deliberately
      //    deactivated on the source install must not be silently recreated as active. No 2.x
      //    source row is missing this column (it's a real, non-nullable 2.x `users.isActive`), so
      //    `false` here only ever covers a malformed/absent test fixture, not a real import.
      isActive: readSourceBoolean(source, 'isActive') ?? false,
      isVerified: readSourceBoolean(source, 'isVerified') ?? true,
      meta: {
        location: readSourceString(source, 'location') ?? '',
        jobTitle: readSourceString(source, 'jobTitle') ?? '',
        // -> No 2.x source column: `pronouns` is a 3.0-only field.
        pronouns: ''
      },
      prefs: {
        timezone: readSourceString(source, 'timezone') ?? 'America/New_York',
        dateFormat: readSourceString(source, 'dateFormat') ?? 'YYYY-MM-DD',
        // -> No 2.x source column: `timeFormat` has no `2.5x-to-3.0-mapping.md` entry.
        timeFormat: '12h',
        appearance: readSourceString(source, 'appearance') ?? 'site',
        // -> No 2.x source column: `cvd` is a 3.0-only field.
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
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Local-provider user conversion, and the router that picks between it and the
// provider fallback above.
// ---------------------------------------------------------------------------

/**
 * Builds the `UserConverter` for 2.x's `local` provider (Feature 414 Task 728's field mapping,
 * implemented as a plain row-builder rather than `Users.importLocalUser()` — that method performs its
 * own `getByEmail`/insert internally and returns `{status, id}`, a shape that does not fit the
 * `UserConverter -> NewUserRow -> writer.insertUser(row)` pattern `createUserImporter()` (Task 12)
 * drives. `createProviderFallbackUserConverter` below already established the
 * precedent that user-row creation in this engine is a raw-insert builder, not a model-method call
 * (unlike group creation, which does go through `Groups.createGroupFromImport()`) — this follows the
 * same shape, with the source's real bcrypt hash copied verbatim instead of a random unusable one.
 *
 * Boolean columns (`mustChangePwd`/`isActive`/`isVerified`) go through `coerceSourceBoolean()` rather
 * than a bare `=== true` check, matching this module's own `readSourceBoolean` convention: the
 * export-bundle connector represents 2.x's boolean columns as JSON `0`/`1` on engines whose knex/
 * Objection layer does that (MySQL/MariaDB/SQLite — see `source-coercion.ts`'s header, OpenProject
 * #1845/#1850), and a bare `=== true` would silently treat every such row as `false`. Timestamp
 * columns go through this module's own `readSourceDate()` — the same "real `Date` or an
 * ISO string, else `undefined`" tolerance `createProviderFallbackUserConverter` uses, shared rather
 * than duplicated.
 */
export interface LocalUserConverterOptions {
  localStrategyId: string
}

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

    const row: NewUserRow = {
      email,
      name,
      auth: {
        [options.localStrategyId]: {
          password: passwordHash,
          mustChangePwd: coerceSourceBoolean(source.mustChangePwd) ?? false,
          restrictLogin: false,
          tfaIsActive: false,
          tfaRequired: false,
          tfaSecret: ''
        }
      },
      isSystem: false,
      isActive: coerceSourceBoolean(source.isActive) ?? false,
      // -> Defaults to `false`, not `true` (unlike `createProviderFallbackUserConverter`'s own
      //    `isVerified` default): for a `local`-provider account this column genuinely tracks whether
      //    2.x's own email-verification flow was completed, so a missing/malformed value is treated
      //    conservatively as "not verified" rather than assumed. The fallback converter's `true`
      //    default reflects a different case entirely -- an account whose provider (github/ldap/...)
      //    already authenticated the email externally, so 2.x's local-only verification concept does
      //    not really apply to it.
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

    return { status: 'created', row }
  }
}

/** Routes a source user record to the real `local`-provider converter or the provider-fallback
 * converter, by `providerKey` — the one real (non-stub) `UserConverter` `phases/users.ts` (Task 14)
 * plugs into `createUserImporter()`. */
export function composeUserConverters(
  local: UserConverter,
  fallback: UserConverter
): UserConverter {
  return (source: SourceRecord) =>
    source.providerKey === 'local' ? local(source) : fallback(source)
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
   * by the Task 731 remap path in `createUserGroupImporter()`, never for an ordinary imported group. Distinct
   * from `insertUserGroup()` because the real writer must go through `Groups.assignUserToGroup()`
   * rather than a raw insert: that model method runs `guestMembershipViolation()` and de-duplicates via
   * `onConflictDoNothing()`, both of which matter for a system group in a way they don't for a fresh,
   * just-created ordinary group. */
  assignUserToSystemGroup(userId: string, groupId: string): Promise<void>
}

/** Real writer, backed by Drizzle. Any insert failure (e.g. `users.email`'s unique constraint) is
 * surfaced to the caller as a thrown error — `importOne()` catches it per-record and
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
// userGroups derivation (Task 14) — `PostgresSourceConnector.users()` (Task 8) denormalizes group
// membership onto each user row as `groups: [{id, name}]` rather than exposing a separate
// `userGroups()` generator (`SourceConnector` has none — see `connector.ts`'s own `users()` doc).
// `deriveUserGroupsFromEmbeddedGroups()` re-expands that embedded shape into the flat
// `{userId, groupId}` records `createUserGroupImporter()` consumes, so `phases/users.ts`'s
// `userGroups` entity can read the same `users()` iterable a second time (a fresh call — each
// connector call re-issues its own query, Task 8) and drive the join-table importer without either
// connector kind ever needing its own `userGroups()` method.
// ---------------------------------------------------------------------------

/** Re-expands each user row's embedded `groups: [{id, name}]` array (`PostgresSourceConnector.users()`,
 * Task 8) into one `{userId, groupId}` record per membership, in source order. A user with no
 * memberships (`groups: []`) yields nothing for that user. */
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

/** Reads a 2.x integer id off a source record, under the given column name. Returns `undefined`
 * (rather than throwing) for a missing/non-numeric value so a malformed record can be reported as
 * `skipped` instead of aborting the whole entity's import. */
function readSourceId(source: SourceRecord, column: string): number | undefined {
  const raw = source[column]
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isInteger(n) ? n : undefined
}

/** Live, per-record import of one id-mapped entity (`groups` or `users`), so a phase entity can drive
 * one source record at a time instead of being handed a whole iterable up front. `summary`/`idMap`
 * are live references into the same closure-scoped bindings every `importOne()` call mutates — not
 * snapshots — so a caller reading them after several calls sees every record processed so far. */
export interface RecordImporter {
  /** Imports one source record, returning the exact `RecordStatus` it recorded onto `summary` for
   * this record: a caller driving `importOne()` directly (`phases/users.ts`) needs this to route its
   * own `WriteRecorder` call correctly, and `importOne()` never throws for a bad/conflicting record,
   * so the return value — not a caught exception — is the only signal. */
  importOne(source: SourceRecord): Promise<RecordStatus>
  readonly summary: EntityImportSummary
  readonly idMap: Map<number, string>
}

export type GroupImporter = RecordImporter

/** `RecordImporter` plus the accumulated provider-fallback flags, which only `users` produces.
 * `providerFallbacks` is the same kind of live reference as `summary`/`idMap`:
 * `createProviderFallbackUserConverter()`-produced accounts accumulate onto it across every
 * `importOne()` call. */
export interface UserImporter extends RecordImporter {
  readonly providerFallbacks: ProviderFallbackFlag[]
}

interface RecordImporterOptions<TRow> {
  convert: (source: SourceRecord) => ConversionOutcome<TRow> | Promise<ConversionOutcome<TRow>>
  insert: (row: TRow) => Promise<{ id: string }>
  /** Recorded verbatim for a source row flagged `isSystem` — the one thing groups and users say
   * differently, since each names its own already-seeded 3.0 equivalent. */
  systemSkipMessage: string
  /** When given, every created record's `providerFallback` (if any) is appended here. */
  providerFallbacks?: ProviderFallbackFlag[]
}

/** Builds an importer for one id-mapped entity. Never throws for one bad or conflicting record; each
 * becomes a `RecordResult` on `summary` instead, so one record's bad data cannot abort the whole
 * run. */
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

/** Live, per-record `userGroups` join-row import — same shape and rationale as `GroupImporter`/
 * `UserImporter` above, extracted from what used to be `importUserGroups()`'s whole `for await`
 * loop. No field-mapping stub is needed here (see the module doc): once both ids resolve, there is
 * nothing left to convert. */
export interface UserGroupImporter {
  /** See `GroupImporter#importOne`'s doc — same Task 14 contract: returns the `RecordStatus` it just
   * recorded onto `summary`. */
  importOne(source: SourceRecord): Promise<RecordStatus>
  readonly summary: EntityImportSummary
}

/** Builds a `UserGroupImporter`. Takes `userIdMap`/`groupIdMap` directly rather than building them
 * itself — the caller (Task 14's phase wiring) passes the SAME `Map` instances
 * `createGroupImporter()`/`createUserImporter()` populate, so a membership resolved here always
 * reflects every group/user imported so far, including ones imported after this importer was
 * constructed.
 *
 * Task 731: a `groupId` that doesn't resolve in `groupIdMap` is not automatically "the group was
 * never created" -- it may be the source's own system Administrators (`SOURCE_SYSTEM_GROUP_ADMIN_ID`)
 * or Guests (`SOURCE_SYSTEM_GROUP_GUEST_ID`) group, which `createGroupImporter()` deliberately skips
 * rather than creates. When `systemGroupIds` is supplied, that specific case is remapped onto this
 * install's real target group via `writer.assignUserToSystemGroup()` instead of being dropped. An
 * ordinary group id that resolves normally through `groupIdMap` never reaches this fallback at all. */
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
