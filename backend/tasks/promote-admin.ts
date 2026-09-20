/* eslint-disable no-console -- CLI entry point: the `usage:` text and the fatal-exit lines are stdout/stderr for a person at a terminal, not log records. */
/**
 * One-shot CLI recovery command for an operator locked out of their only admin account: short of
 * direct DB surgery, there is no other way to grant `manage:system` after first boot.
 *
 * Standalone entry point (`npm run promote-admin -- <email>` from `backend/`), never imported by
 * `index.ts`, `worker.ts`, `core/scheduler.ts`'s `tasks/simple/` discovery — or by a test, since
 * `main()` runs unconditionally at module scope. That is why everything this file wires together
 * lives in `promoteAdminRuntime.ts`, which IS safe to import.
 */

import { bootstrapPromoteAdminRuntime, promoteUserToAdmin } from './promoteAdminRuntime.ts'

async function main(): Promise<void> {
  const email = process.argv[2]
  if (!email) {
    console.error('Usage: node backend/tasks/promote-admin.ts <email>')
    process.exitCode = 1
    return
  }

  const CARDINAL = await bootstrapPromoteAdminRuntime()

  // An open pg Pool keeps the event loop alive, and nothing else here does: without closing it the
  // CLI finishes its work but never hands control back to whoever ran it.
  try {
    const result = await promoteUserToAdmin(CARDINAL, email)
    // -> The user id, not the e-mail address the operator typed: an identity does not belong in the
    //    log even when the person running the command already knows it.
    if (result.status === 'already-admin') {
      CARDINAL.logger.info('boot', 'already a member of the Administrators group, nothing to do', {
        user: result.userId
      })
    } else {
      CARDINAL.logger.info('boot', 'promoted to Administrator', { user: result.userId })
      CARDINAL.logger.info(
        'boot',
        'if this user has an active session, they must log out and back in for the new ' +
          'permissions to take effect'
      )
    }
  } finally {
    await CARDINAL.dbManager.pool?.end()
  }
}

main().catch((err: any) => {
  console.error(err.stack ?? err.message ?? err)
  process.exitCode = 1
})
