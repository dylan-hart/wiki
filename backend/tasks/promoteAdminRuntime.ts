/**
 * The bootstrap and business logic behind `promote-admin.ts` — split out so it can be imported by a
 * test (`promoteAdminRuntime.db.test.ts`) without ever running `promote-admin.ts`'s own `main()`, the
 * same reason `migration/bootstrap.ts` and `migration/orchestrator.ts` sit apart from `tasks/migrate.ts`
 * itself. See `promote-admin.ts`'s own doc comment for why the CLI entry point is never imported.
 */

import path from 'node:path'
import configSvc from '../core/config.ts'
import dbManager from '../core/db.ts'
import logger from '../core/logger.ts'

/**
 * The minimal, synchronous part of the `WIKI` global this command needs before any I/O runs —
 * modeled on `worker.ts`'s own literal, not `index.ts`'s full boot or `migration/bootstrap.ts`'s
 * heavier migration-only shell (no `auth`/`SourceConnector` concerns here).
 */
function buildWikiShell(): Pick<
  WikiGlobal,
  'IS_DEBUG' | 'ROOTPATH' | 'INSTANCE_ID' | 'SERVERPATH' | 'configSvc'
> {
  return {
    IS_DEBUG: process.env.NODE_ENV === 'development',
    ROOTPATH: process.cwd(),
    INSTANCE_ID: 'promote-admin-cli',
    SERVERPATH: path.join(process.cwd(), 'backend'),
    configSvc
  }
}

/**
 * Sets up the ambient `WIKI` global and connects it to the target database: `configSvc`, `logger`,
 * then `dbManager.init(true)` — workerMode, same as `worker.ts`'s own `ensureDb()` — deliberately
 * skipping `syncSchemas()`/`checkForLegacyInstall()`. Unlike `migrate.ts` (which is importing INTO a
 * freshly-prepared 3.0 destination and legitimately wants schema migrations run as part of that), this
 * command targets an already-running, already-migrated instance: a recovery command that silently
 * triggered a schema migration as a side effect would be a surprising thing for it to do.
 *
 * Only the three models the promotion actually reaches through are loaded — `settings` (so
 * `configSvc.loadFromDb()` can resolve `WIKI.config.auth.rootAdminGroupId`), `users` (email lookup)
 * and `groups` (`assignUserToGroup`) — not the full 27-model registry `models/index.ts` exports, the
 * same principle `worker.ts` and `migration/bootstrap.ts#loadModels()` already follow.
 */
export async function bootstrapPromoteAdminRuntime(): Promise<WikiGlobal> {
  const WIKI = buildWikiShell() as unknown as WikiGlobal
  global.WIKI = WIKI

  await WIKI.configSvc.init()
  WIKI.logger = logger.init()

  WIKI.dbManager = dbManager
  WIKI.db = await dbManager.init(true)

  const [{ settings }, { users }, { groups }] = await Promise.all([
    import('../models/settings.ts'),
    import('../models/users.ts'),
    import('../models/groups.ts')
  ])
  WIKI.models = { settings, users, groups } as WikiGlobal['models']

  // `WIKI.config.auth.rootAdminGroupId` is a per-install id `Settings.init()` generated once and
  // persisted to the `settings` table at seed time (see `models/settings.ts`) -- `configSvc.init()`
  // above only merges config.yml + base.yml, neither of which knows it. A `false` return means the
  // `settings` table is empty, i.e. this is not a previously-booted 3.0 install -- refused up front
  // with an actionable message rather than letting `promoteUserToAdmin()` fail later on a silently
  // `undefined` group id.
  if (!(await WIKI.configSvc.loadFromDb())) {
    throw new Error(
      'No settings found in this database. This command promotes a user on an existing, ' +
        'previously-booted Wiki.js 3.0 install -- boot the server against this database at least ' +
        'once first.'
    )
  }

  return WIKI
}

export type PromoteAdminResult =
  | { status: 'promoted'; userId: string }
  | { status: 'already-admin'; userId: string }

/**
 * Promotes an existing user (by email) into the instance's root Administrators group.
 *
 * Deliberately thin: `WIKI.models.groups.assignUserToGroup()` already does everything a promotion
 * needs -- it's idempotent (`onConflictDoNothing`, so promoting an already-admin user is a no-op, not
 * an error) and it already refuses to add the guest/system account to any group but the guests group
 * (`guestMembershipViolation`), which is exactly the "don't let this command touch the guest account"
 * guard this command would otherwise have to write for itself.
 *
 * @throws If no user has this email, or if the destination's Administrators group id cannot be
 * resolved (see `bootstrapPromoteAdminRuntime()`).
 */
export async function promoteUserToAdmin(
  WIKI: WikiGlobal,
  email: string
): Promise<PromoteAdminResult> {
  const user = await WIKI.models.users.getByEmail(email)
  if (!user) {
    throw new Error(`No user found with email "${email}".`)
  }

  const adminGroupId = WIKI.config.auth?.rootAdminGroupId
  if (!adminGroupId) {
    throw new Error(
      'Could not resolve the Administrators group id from this install ' +
        '(settings.auth.rootAdminGroupId is missing or malformed).'
    )
  }

  const inserted = await WIKI.models.groups.assignUserToGroup(adminGroupId, user.id)
  return { status: inserted ? 'promoted' : 'already-admin', userId: user.id }
}
