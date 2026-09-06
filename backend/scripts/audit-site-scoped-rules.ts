/* eslint-disable no-console -- a one-off operator script: its stdout IS its result, and it runs outside a booted `WIKI`. */
/*
  One-off pre-deploy diagnostic for "Per-site page-rule enforcement" (feature 406).

  Until that fix ships, `GroupRule.sites` is a field an administrator can set in the group editor
  but that `helpers/pageRules.ts` has never actually consulted — every rule matched every site. The
  moment the fix lands, any rule with a non-empty `sites` array starts being enforced for real, which
  narrows that rule's effective reach to the sites it names. For a rule an admin scoped intentionally
  that is the point; for one where `sites` was set by accident, or left over from before this field
  did anything, it silently starts denying access it used to grant.

  This script finds every such rule ahead of time so a deploying admin can review the list — not a
  compatibility shim, and not something this repo ships as a permanent feature. Per this repo's
  CLAUDE.md, migration shims and legacy-data fallbacks are exactly what this codebase avoids; this
  is the opposite of one, an audit that is read once and thrown away. Run it by hand, from the repo
  root, against each environment's real database, once before deploying the fix there:

    node backend/scripts/audit-site-scoped-rules.ts

  It connects to the database the same way `models/groups.ts`'s `reloadCache()` does (via `WIKI.db`,
  Drizzle), reads every group's `rules` column, and prints (group name, rule name, rule.sites,
  rule.roles, rule.mode) for each rule whose `sites` array is non-empty. It makes no changes.

  There is no dev-environment data to worry about today — this is the one genuine pre-deploy check
  this change requires before it reaches an environment with real group configurations.
*/
import path from 'node:path'
import configSvc from '../core/config.ts'
import logger from '../core/logger.ts'
import dbManager from '../core/db.ts'
import { groups as groupsTable } from '../db/schema.ts'
import type { GroupRule, GroupRuleMode } from '../models/groups.ts'

/** The shape this script needs out of a group row: just enough to report on its rules. */
export interface GroupRulesRow {
  id: string
  name: string
  rules: GroupRule[]
}

/** One site-scoped rule, flattened out to the fields the deploying admin needs to see. */
export interface SiteScopedRuleReport {
  groupName: string
  ruleName: string
  sites: string[]
  roles: string[]
  mode: GroupRuleMode
}

/** Every rule, across every group, whose `sites` array is non-empty — the ones enforcement changes for. */
export function findSiteScopedRules(groups: GroupRulesRow[]): SiteScopedRuleReport[] {
  const report: SiteScopedRuleReport[] = []
  for (const group of groups) {
    for (const rule of group.rules ?? []) {
      if (rule.sites?.length > 0) {
        report.push({
          groupName: group.name,
          ruleName: rule.name,
          sites: rule.sites,
          roles: rule.roles,
          mode: rule.mode
        })
      }
    }
  }
  return report
}

/** One human-readable line per site-scoped rule, ready to print. */
export function formatReportLines(report: SiteScopedRuleReport[]): string[] {
  return report.map(
    (r) =>
      `group "${r.groupName}" — rule "${r.ruleName}" — sites: [${r.sites.join(', ')}] — roles: [${r.roles.join(', ')}] — mode: ${r.mode}`
  )
}

/** Standalone entrypoint — not exercised by the test file, which drives the two functions above directly. */
async function main() {
  const WIKI = {
    IS_DEBUG: process.env.NODE_ENV === 'development',
    ROOTPATH: process.cwd(),
    SERVERPATH: path.join(process.cwd(), 'backend'),
    INSTANCE_ID: 'audit-site-scoped-rules',
    configSvc
  } as unknown as WikiGlobal
  global.WIKI = WIKI

  await WIKI.configSvc.init(true)
  WIKI.logger = logger.init()
  WIKI.dbManager = dbManager
  WIKI.db = await dbManager.init(true)

  const rows = await WIKI.db
    .select({ id: groupsTable.id, name: groupsTable.name, rules: groupsTable.rules })
    .from(groupsTable)

  const report = findSiteScopedRules(rows as GroupRulesRow[])

  if (report.length === 0) {
    console.log('No site-scoped rules found — this fix changes nothing for the current groups.')
  } else {
    console.log(
      `${report.length} site-scoped rule(s) found. Their effective access changes once this fix ships:\n`
    )
    for (const line of formatReportLines(report)) {
      console.log(line)
    }
  }

  process.exit(0)
}

// Only run when executed directly (`node backend/scripts/audit-site-scoped-rules.ts`) — importing
// this module (as the test file does, for `findSiteScopedRules`/`formatReportLines`) must not
// connect to a database or touch `process.exit`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
