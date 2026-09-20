import path from 'node:path'
import configSvc from '../core/config.ts'
import dbManager from '../core/db.ts'
import logger from '../core/logger.ts'

function buildWikiShell(): Pick<
  CardinalGlobal,
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
 * `dbManager.init(true)` is workerMode, which skips `syncSchemas()`/`checkForLegacyInstall()`: this
 * command targets an already-running, already-migrated instance, and a recovery command that
 * silently triggered a schema migration as a side effect would be a surprising thing for it to do.
 *
 * Only the three models the promotion reaches through are loaded, not the whole `models/index.ts`
 * registry: `settings` (so `loadFromDb()` can resolve `auth.rootAdminGroupId`), `users` and `groups`.
 */
export async function bootstrapPromoteAdminRuntime(): Promise<CardinalGlobal> {
  const CARDINAL = buildWikiShell() as unknown as CardinalGlobal
  global.CARDINAL = CARDINAL

  await CARDINAL.configSvc.init()
  CARDINAL.logger = logger.init()

  CARDINAL.dbManager = dbManager
  CARDINAL.db = await dbManager.init(true)

  const [{ settings }, { users }, { groups }] = await Promise.all([
    import('../models/settings.ts'),
    import('../models/users.ts'),
    import('../models/groups.ts')
  ])
  CARDINAL.models = { settings, users, groups } as CardinalGlobal['models']

  // `auth.rootAdminGroupId` is a per-install id seeded into the `settings` table; `configSvc.init()`
  // above only merges config.yml + base.yml, neither of which knows it. `false` means that table is
  // empty -- refused here rather than letting `promoteUserToAdmin()` fail on an undefined group id.
  if (!(await CARDINAL.configSvc.loadFromDb())) {
    throw new Error(
      'No settings found in this database. This command promotes a user on an existing, ' +
        'previously-booted Cardinal.js 3.0 install -- boot the server against this database at least ' +
        'once first.'
    )
  }

  return CARDINAL
}

export type PromoteAdminResult =
  | { status: 'promoted'; userId: string }
  | { status: 'already-admin'; userId: string }

/**
 * Deliberately thin: `assignUserToGroup()` is idempotent (`onConflictDoNothing`, so promoting an
 * already-admin user is a no-op rather than an error) and already refuses to put the guest/system
 * account in any group but guests -- the guard this command would otherwise have to write itself.
 */
export async function promoteUserToAdmin(
  CARDINAL: CardinalGlobal,
  email: string
): Promise<PromoteAdminResult> {
  const user = await CARDINAL.models.users.getByEmail(email)
  if (!user) {
    throw new Error(`No user found with email "${email}".`)
  }

  const adminGroupId = CARDINAL.config.auth?.rootAdminGroupId
  if (!adminGroupId) {
    throw new Error(
      'Could not resolve the Administrators group id from this install ' +
        '(settings.auth.rootAdminGroupId is missing or malformed).'
    )
  }

  const inserted = await CARDINAL.models.groups.assignUserToGroup(adminGroupId, user.id)
  return { status: inserted ? 'promoted' : 'already-admin', userId: user.id }
}
