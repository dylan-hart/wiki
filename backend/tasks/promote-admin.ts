/**
 * One-shot CLI recovery command: promote an existing user to admin.
 *
 * For an operator locked out of their only admin account (Issue #2384 / Feature #2431) — no
 * supported way existed to grant `manage:system` after first boot short of direct DB surgery.
 *
 * Standalone entry point: run via `node backend/tasks/promote-admin.ts <email>` or
 * `npm run promote-admin -- <email>` from `backend/`. Mirrors `tasks/migrate.ts`'s shape: deliberately
 * never imported by `index.ts`, `worker.ts`, or `core/scheduler.ts`'s `tasks/simple/` discovery, and
 * deliberately never imported by a test either (its `main()` runs unconditionally at module scope, the
 * same reason `tasks/migrate.ts` stays out of `migrate.test.ts`'s own imports) -- the bootstrap and
 * promotion logic this file only wires together live in `promoteAdminRuntime.ts`, which IS safe to
 * import from a test.
 */

import { bootstrapPromoteAdminRuntime, promoteUserToAdmin } from './promoteAdminRuntime.ts'

async function main(): Promise<void> {
  const email = process.argv[2]
  if (!email) {
    console.error('Usage: node backend/tasks/promote-admin.ts <email>')
    process.exitCode = 1
    return
  }

  const WIKI = await bootstrapPromoteAdminRuntime()

  // Same reasoning as `migrate.ts`'s own `finally`: nothing else keeps the event loop alive once this
  // is done, but an open pg Pool does -- without closing it, the CLI would finish its own logic but
  // never hand control back to whoever ran it.
  try {
    const result = await promoteUserToAdmin(WIKI, email)
    if (result.status === 'already-admin') {
      WIKI.logger.info(`"${email}" is already a member of the Administrators group. Nothing to do.`)
    } else {
      WIKI.logger.info(`"${email}" has been promoted to Administrator (user id ${result.userId}).`)
      WIKI.logger.info(
        'If this user has an active session, they must log out and back in for the new ' +
          'permissions to take effect.'
      )
    }
  } finally {
    await WIKI.dbManager.pool?.end()
  }
}

main().catch((err: any) => {
  console.error(err.stack ?? err.message ?? err)
  process.exitCode = 1
})
