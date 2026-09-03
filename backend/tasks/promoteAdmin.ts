/**
 * Business logic behind the `promote-admin` CLI (`./promote-admin.ts`) — split out so it is testable
 * without booting a real database, mirroring `migration/cli.ts`'s split from `tasks/migrate.ts`.
 */

import { Command } from 'commander'

export interface ParsedPromoteAdminArgs {
  /** Already lowercased and trimmed, matching every other `getByEmail()` call site's convention. */
  email: string
}

function buildProgram(): Command {
  const program = new Command()
  program
    .name('promote-admin')
    .description(
      'Promote an existing user to the Administrators group -- a recovery path for an operator ' +
        'locked out of their only admin account.'
    )
    .requiredOption('--email <email>', 'Email address of the user to promote')
  // -> Same two settings `migration/source-args.ts#buildSourceProgram` uses: `exitOverride()` so
  //    commander throws instead of calling `process.exit` (which would make a parse-error test kill
  //    the test runner), and a silenced output so its own usage text never reaches the console.
  program.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  return program
}

/**
 * Parses bare argv (no `node`/script path prefix) into a resolved `ParsedPromoteAdminArgs`. Takes
 * bare argv so it is callable the same way from the CLI entry point
 * (`./promote-admin.ts`, via `process.argv.slice(2)`) and from tests.
 *
 * @throws A plain `Error` (never commander's own `CommanderError`) describing what was wrong.
 */
export function parsePromoteAdminArgs(argv: string[]): ParsedPromoteAdminArgs {
  const program = buildProgram()
  try {
    program.parse(argv, { from: 'user' })
  } catch (err: any) {
    throw new Error(err.message)
  }
  const opts = program.opts<{ email: string }>()
  const email = opts.email.trim().toLowerCase()
  if (!email) {
    throw new Error('--email must not be empty')
  }
  return { email }
}

export type PromoteAdminOutcome =
  | { status: 'promoted'; userId: string; name: string; email: string }
  | { status: 'already-admin'; userId: string; name: string; email: string }
  | { status: 'not-found'; email: string }
  | { status: 'system-account'; email: string }

/** The subset of `WIKI` this task needs — never the full registry, same principle `worker.ts` and
 * `migration/bootstrap.ts` follow for their own narrow model sets. */
export type PromoteAdminWiki = Pick<WikiGlobal, 'config'> & {
  models: Pick<WikiGlobal['models'], 'users' | 'groups'>
}

/**
 * Promotes an existing user to the Administrators group, additively: existing group memberships
 * (editor roles, a delegated `site:*` group, ...) are preserved by passing `setUserGroups()` the
 * union of what the user already has plus the admin group, never a bare `[adminGroupId]` that would
 * silently strip every other membership.
 *
 * A system account (the guest account is the only one that currently exists) is refused explicitly
 * rather than silently no-op'd: `setUserGroups()` itself returns early for `isSystem` users, which
 * would otherwise make this report `'promoted'` for a write that never actually happened.
 *
 * @throws When `WIKI.config.auth.rootAdminGroupId` cannot be resolved -- an unseeded or corrupt
 * `settings` row, which the caller should have already ruled out via `WIKI.configSvc.loadFromDb()`
 * before calling this.
 */
export async function promoteUserToAdmin(
  WIKI: PromoteAdminWiki,
  email: string
): Promise<PromoteAdminOutcome> {
  const adminGroupId = WIKI.config.auth?.rootAdminGroupId
  if (!adminGroupId) {
    throw new Error(
      'Could not resolve the Administrators group id from this installation ' +
        '(settings.auth.rootAdminGroupId is missing) -- is this a previously-booted 3.0 install?'
    )
  }

  const user = await WIKI.models.users.getByEmail(email)
  if (!user) {
    return { status: 'not-found', email }
  }
  if (user.isSystem) {
    return { status: 'system-account', email }
  }

  const alreadyAdmin = await WIKI.models.groups.isUserInGroup(adminGroupId, user.id)
  if (alreadyAdmin) {
    return { status: 'already-admin', userId: user.id, name: user.name, email: user.email }
  }

  const currentGroupIds = await WIKI.models.users.getUserGroupIds(user.id)
  await WIKI.models.users.setUserGroups(user.id, [...currentGroupIds, adminGroupId])
  return { status: 'promoted', userId: user.id, name: user.name, email: user.email }
}
