import { coerceSourceBoolean } from '../source-coercion.ts'
import type { SourceRecord } from '../connector.ts'
import type { NewUserRow, UserConverter } from './users-groups.ts'

/**
 * Builds the `UserConverter` for 2.x's `local` provider (Feature 414 Task 728's field mapping,
 * implemented as a plain row-builder rather than `Users.importLocalUser()` — that method performs its
 * own `getByEmail`/insert internally and returns `{status, id}`, a shape that does not fit the
 * `UserConverter -> NewUserRow -> writer.insertUser(row)` pattern `createUserImporter()` (Task 12)
 * drives. `createProviderFallbackUserConverter` in `./users-groups.ts` already established the
 * precedent that user-row creation in this engine is a raw-insert builder, not a model-method call
 * (unlike group creation, which does go through `Groups.createGroupFromImport()`) — this follows the
 * same shape, with the source's real bcrypt hash copied verbatim instead of a random unusable one.
 *
 * Boolean columns (`mustChangePwd`/`isActive`/`isVerified`) go through `coerceSourceBoolean()` rather
 * than a bare `=== true` check, matching `users-groups.ts`'s own `readSourceBoolean` convention: the
 * export-bundle connector represents 2.x's boolean columns as JSON `0`/`1` on engines whose knex/
 * Objection layer does that (MySQL/MariaDB/SQLite — see `source-coercion.ts`'s header, OpenProject
 * #1845/#1850), and a bare `=== true` would silently treat every such row as `false`. Timestamp
 * columns go through the same "real `Date` or an ISO string, else `undefined`" tolerance
 * `createProviderFallbackUserConverter`'s `readSourceDate` gives, for the same reason.
 */
export interface LocalUserConverterOptions {
  localStrategyId: string
}

/** Reads a timestamp column off a source record — same tolerance as
 * `users-groups.ts`'s (private) `readSourceDate`: a live `PostgresSourceConnector` hands back a real
 * `Date`, an export-bundle/JSON-backed connector may hand back an ISO string instead. Anything else
 * degrades to `undefined` rather than failing the whole record. */
function readDate(source: SourceRecord, column: string): Date | undefined {
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
      createdAt: readDate(source, 'createdAt'),
      updatedAt: readDate(source, 'updatedAt'),
      lastLoginAt: readDate(source, 'lastLoginAt')
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
