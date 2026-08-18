/**
 * Wiki.js 2.5.x -> 3.0 migration CLI.
 *
 * Standalone entry point: run via `node backend/tasks/migrate.ts <args>` or `npm run migrate --
 * <args>` from `backend/`. Deliberately never imported by `index.ts`, `worker.ts`, or
 * `core/scheduler.ts`'s `tasks/simple/` discovery — this opens a second, *foreign* (2.x) database
 * connection alongside the 3.0 destination, which nothing else in this codebase does or should do.
 *
 * The bootstrap below is modeled on `worker.ts`'s minimal `WIKI` global, not `index.ts`'s full boot:
 * no HTTP server, no scheduler, no cache, no collab websockets — just enough to talk to the 3.0
 * destination database and run the model methods each import phase needs. Unlike `worker.ts`, this
 * legitimately runs `dbManager.init()` with `checkForLegacyInstall` still in effect: the *destination*
 * must be a current 3.0 schema, so refusing a 2.x-shaped destination is exactly the right check here,
 * only ever run against the destination, never the 2.x source (which is read through the separate
 * `SourceConnector` interface — Feature 412 — and is expected to look like a 2.x database).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import configSvc from '../core/config.ts'
import dbManager from '../core/db.ts'
import logger from '../core/logger.ts'
import { ExportBundleSourceConnector } from '../migration/connectors/export-bundle.ts'
import { PostgresSourceConnector } from '../migration/connectors/postgres.ts'
import { parseMigrationArgs } from '../migration/cli.ts'
import { MIGRATION_PHASES } from '../migration/phases/index.ts'
import { runMigration } from '../migration/orchestrator.ts'
import { createProvenanceStore } from '../migration/provenance.ts'
import { formatReportTable, reportsToJson } from '../migration/render.ts'
import { emptyPhaseReport } from '../migration/report.ts'
import type { MigrationContext } from '../migration/context.ts'
import type { ParsedMigrationArgs } from '../migration/cli.ts'
import type { SourceConnector } from '../migration/connector.ts'

// ----------------------------------------
// Init Minimal Core
// ----------------------------------------

const WIKI = {
  IS_DEBUG: process.env.NODE_ENV === 'development',
  ROOTPATH: process.cwd(),
  INSTANCE_ID: 'migrate-cli',
  SERVERPATH: path.join(process.cwd(), 'backend'),
  configSvc
} as unknown as WikiGlobal
global.WIKI = WIKI

/**
 * Only the models an import phase actually reads/writes through — `sites`, `settings`, `users`,
 * `groups`, `authentication`, `storage`, `tags`, `tree`, `pages`, `pageHistory`, `assets` — never the
 * full 27-model registry `models/index.ts` exports. Same principle `worker.ts` follows for its one
 * model: a one-shot process pays the import cost of everything it pulls in, and the full registry
 * drags in cheerio, sanitize-html, bcrypt and the rest of the HTTP-server-only models for a script
 * that never serves a request.
 */
async function loadModels(): Promise<WikiGlobal['models']> {
  const [
    { sites },
    { settings },
    { users },
    { groups },
    { authentication },
    { storage },
    { tags },
    { tree },
    { pages },
    { pageHistory },
    { assets }
  ] = await Promise.all([
    import('../models/sites.ts'),
    import('../models/settings.ts'),
    import('../models/users.ts'),
    import('../models/groups.ts'),
    import('../models/authentication.ts'),
    import('../models/storage.ts'),
    import('../models/tags.ts'),
    import('../models/tree.ts'),
    import('../models/pages.ts'),
    import('../models/pageHistory.ts'),
    import('../models/assets.ts')
  ])
  return {
    sites,
    settings,
    users,
    groups,
    authentication,
    storage,
    tags,
    tree,
    pages,
    pageHistory,
    assets
  } as WikiGlobal['models']
}

function buildSourceConnector(source: ParsedMigrationArgs['source']): SourceConnector {
  return source.kind === 'postgres'
    ? new PostgresSourceConnector(source.config)
    : new ExportBundleSourceConnector(source.path)
}

async function main(): Promise<void> {
  const args = parseMigrationArgs(process.argv.slice(2))

  await WIKI.configSvc.init()
  WIKI.logger = logger.init()

  WIKI.logger.info('=======================================')
  WIKI.logger.info('= Wiki.js 2.5.x -> 3.0 Migration CLI  =')
  WIKI.logger.info('=======================================')
  if (args.dryRun) {
    WIKI.logger.info('Dry run: no destination writes will be made.')
  }
  if (args.updateExisting) {
    WIKI.logger.info(
      'Update-existing: an already-imported row will be updated in place, not skipped.'
    )
  }

  WIKI.dbManager = dbManager
  // workerMode defaults to false, so this runs syncSchemas() -> checkForLegacyInstall() + migrations
  // against the 3.0 destination, same as index.ts's preBoot().
  WIKI.db = await dbManager.init()
  WIKI.models = await loadModels()

  // Unlike index.ts's server, this process has nothing else keeping the event loop alive once it's
  // done — an open pg Pool does, though, so without closing it here the CLI would exit its own logic
  // but never actually return control to whoever ran it (a real bug an operator would hit on every
  // invocation, dry-run or not).
  try {
    await runAgainstDestination(args)
  } finally {
    await WIKI.dbManager.pool?.end()
  }
}

async function runAgainstDestination(args: ParsedMigrationArgs): Promise<void> {
  const site = await WIKI.models.sites.getSiteById({ id: args.siteId, forceReload: true })
  if (!site) {
    WIKI.logger.error(`Destination site "${args.siteId}" was not found. Exiting...`)
    process.exitCode = 1
    return
  }

  const source = buildSourceConnector(args.source)
  await source.connect()
  try {
    const description = await source.describe()
    WIKI.logger.info(
      `Source: ${description.kind} at ${description.location}` +
        (description.version ? ` (detected version ${description.version})` : '')
    )
    for (const note of description.notes) {
      WIKI.logger.info(`  - ${note}`)
    }

    const ctx: MigrationContext = {
      db: WIKI.db,
      source,
      siteId: args.siteId,
      dryRun: args.dryRun,
      // Feature 421 task 746: idempotent re-runs. `provenanceStore` is built once, here, from the
      // real destination `db` — never per-phase — so every phase checks the same table.
      provenanceStore: createProvenanceStore(WIKI.db),
      updateExisting: args.updateExisting,
      log: (message) => WIKI.logger.info(message)
    }

    const results = await runMigration(MIGRATION_PHASES, ctx, { only: args.only })

    WIKI.logger.info('=======================================')
    WIKI.logger.info('Migration summary:')
    for (const result of results) {
      const detail = result.counts ? ` ${JSON.stringify(result.counts)}` : ''
      WIKI.logger.info(`  ${result.phase}: ${result.status}${detail}`)
      if (result.notImplemented?.length) {
        WIKI.logger.info(`    not yet implemented: ${result.notImplemented.join(', ')}`)
      }
      if (result.errors?.length) {
        for (const message of result.errors) {
          WIKI.logger.error(`    ${message}`)
        }
      }
    }

    // Dry-run/report mode (Feature 421 task 744): the console table is always printed, regardless of
    // `--dry-run` — it is exactly as informative for a live run, and `--report-file` additionally
    // writes it as JSON for diffing between runs (e.g. two dry runs against the same source/
    // destination pair, to confirm nothing changed).
    const reports = results.map((result) => result.report ?? emptyPhaseReport(result.phase))
    process.stdout.write(`\n${formatReportTable(reports)}\n`)
    if (args.reportFile) {
      await fs.writeFile(args.reportFile, `${reportsToJson(reports)}\n`, 'utf8')
      WIKI.logger.info(`Report written to ${args.reportFile}`)
    }

    process.exitCode = results.some((result) => result.status === 'error') ? 1 : 0
  } finally {
    await source.disconnect()
  }
}

main().catch((err: any) => {
  console.error(err.stack ?? err.message ?? err)
  process.exitCode = 1
})
