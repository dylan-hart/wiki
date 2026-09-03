/**
 * One-shot CLI recovery command: promotes an existing user to the Administrators group, for an
 * operator who is locked out of their only admin account. Mirrors `tasks/migrate.ts`'s shape --
 * standalone entry point, deliberately never imported by `index.ts`, `worker.ts`, or
 * `core/scheduler.ts`'s `tasks/simple/` discovery. Run via `node backend/tasks/promote-admin.ts
 * --email <email>` or `npm run promote-admin -- --email <email>` from `backend/`.
 *
 * The bootstrap here is modeled on `worker.ts`'s minimal `WIKI` global, not `index.ts`'s full boot:
 * no HTTP server, no scheduler, no cache, no collab websockets -- just enough to talk to the database
 * and run the `users`/`groups` model methods this needs. `dbManager.init()` runs with its default
 * `workerMode: false`, same as `migrate.ts`, since this is a standalone process talking directly to
 * the database rather than a worker thread inside an already-migrated main server process.
 *
 * Business logic lives in `./promoteAdmin.ts`, which is what is unit-tested -- this file is the thin,
 * DB-connecting wrapper, the same split `migrate.ts`/`migration/cli.ts` use.
 */

import path from 'node:path'
import configSvc from '../core/config.ts'
import dbManager from '../core/db.ts'
import logger from '../core/logger.ts'
import { ensureTemporal } from '../core/temporal.ts'
import { parsePromoteAdminArgs, promoteUserToAdmin } from './promoteAdmin.ts'
import type { PromoteAdminOutcome } from './promoteAdmin.ts'

async function main(): Promise<void> {
  const args = parsePromoteAdminArgs(process.argv.slice(2))

  await ensureTemporal()

  const WIKI = {
    IS_DEBUG: process.env.NODE_ENV === 'development',
    ROOTPATH: process.cwd(),
    INSTANCE_ID: 'promote-admin-cli',
    SERVERPATH: path.join(process.cwd(), 'backend'),
    configSvc,
    auth: { groups: {}, strategies: {} }
  } as unknown as WikiGlobal
  global.WIKI = WIKI

  await WIKI.configSvc.init()
  WIKI.logger = logger.init()
  WIKI.dbManager = dbManager
  WIKI.db = await dbManager.init()
  // -> Only the three models this task actually calls through, not the full 27-model registry --
  //    same principle `worker.ts` and `migration/bootstrap.ts#loadModels()` follow: a one-shot
  //    process pays the import cost of everything it pulls in.
  WIKI.models = {
    settings: (await import('../models/settings.ts')).settings,
    users: (await import('../models/users.ts')).users,
    groups: (await import('../models/groups.ts')).groups
  } as WikiGlobal['models']

  try {
    // `WIKI.config.auth.rootAdminGroupId` is a per-install id `Settings.init()` persisted to the
    // `settings` table at seed time -- `configSvc.init()` alone (config.yml + base.yml) never
    // populates it, so `loadFromDb()` is required before `promoteUserToAdmin()` can resolve it.
    if (!(await WIKI.configSvc.loadFromDb())) {
      WIKI.logger.error(
        'No settings found in this database. This must be a previously-booted 3.0 install (run the ' +
          'main Wiki.js server against it at least once) before promoting a user. Exiting...'
      )
      process.exitCode = 1
      return
    }

    const outcome = await promoteUserToAdmin(WIKI, args.email)
    reportOutcome(WIKI, outcome)
  } finally {
    await WIKI.dbManager.pool?.end()
  }
}

function reportOutcome(WIKI: WikiGlobal, outcome: PromoteAdminOutcome): void {
  switch (outcome.status) {
    case 'promoted':
      WIKI.logger.info(`Promoted ${outcome.name} <${outcome.email}> to the Administrators group.`)
      break
    case 'already-admin':
      WIKI.logger.info(
        `${outcome.name} <${outcome.email}> is already a member of the Administrators group. Nothing to do.`
      )
      break
    case 'not-found':
      WIKI.logger.error(`No user found with email "${outcome.email}". Exiting...`)
      process.exitCode = 1
      break
    case 'system-account':
      WIKI.logger.error(`"${outcome.email}" is a system account and cannot be promoted. Exiting...`)
      process.exitCode = 1
      break
  }
}

main().catch((err: any) => {
  console.error(err.stack ?? err.message ?? err)
  process.exitCode = 1
})
