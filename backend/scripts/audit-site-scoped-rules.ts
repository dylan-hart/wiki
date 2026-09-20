/* eslint-disable no-console -- a one-off operator script: its stdout IS its result, and it runs outside a booted `CARDINAL`. */
/*
  A read-only audit of every `GroupRule` carrying a non-empty `sites` array — the rules whose reach
  `helpers/pageRules.ts` narrows to the sites they name. An admin runs it by hand, from the repo root,
  against a real database, to review rules whose `sites` was set by accident and which therefore deny
  access a site-blind rule would grant:

    node backend/scripts/audit-site-scoped-rules.ts

  It connects the same way `models/groups.ts`'s `reloadCache()` does (`CARDINAL.db`) and changes nothing.
*/
import path from 'node:path'
import configSvc from '../core/config.ts'
import logger from '../core/logger.ts'
import dbManager from '../core/db.ts'
import { groups as groupsTable } from '../db/schema.ts'
import type { GroupRule, GroupRuleMode } from '../models/groups.ts'

export interface GroupRulesRow {
  id: string
  name: string
  rules: GroupRule[]
}

export interface SiteScopedRuleReport {
  groupName: string
  ruleName: string
  sites: string[]
  roles: string[]
  mode: GroupRuleMode
}

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

export function formatReportLines(report: SiteScopedRuleReport[]): string[] {
  return report.map(
    (r) =>
      `group "${r.groupName}" — rule "${r.ruleName}" — sites: [${r.sites.join(', ')}] — roles: [${r.roles.join(', ')}] — mode: ${r.mode}`
  )
}

async function main() {
  const CARDINAL = {
    IS_DEBUG: process.env.NODE_ENV === 'development',
    ROOTPATH: process.cwd(),
    SERVERPATH: path.join(process.cwd(), 'backend'),
    INSTANCE_ID: 'audit-site-scoped-rules',
    configSvc
  } as unknown as CardinalGlobal
  global.CARDINAL = CARDINAL

  await CARDINAL.configSvc.init(true)
  CARDINAL.logger = logger.init()
  CARDINAL.dbManager = dbManager
  CARDINAL.db = await dbManager.init(true)

  const rows = await CARDINAL.db
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

// Importing this module (as the test does, for the two exported functions) must not connect to a
// database or touch `process.exit`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
