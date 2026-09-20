/* eslint-disable no-console -- CLI entry point: the `usage:` text and the fatal-exit lines are stdout/stderr for a person at a terminal, not log records. */
/**
 * Wiki.js 2.5.x -> 3.0 migration CLI. Standalone entry point (`npm run migrate -- <args>` from
 * `backend/`), deliberately never imported by `index.ts`, `worker.ts` or `core/scheduler.ts`'s
 * `tasks/simple/` discovery: it opens a second, *foreign* (2.x) database connection alongside the
 * 3.0 destination, which nothing else in this codebase does or should do.
 *
 * `../migration/bootstrap.ts` gives it `worker.ts`'s minimal `CARDINAL` rather than `index.ts`'s full
 * boot — no HTTP server, scheduler, cache or collab websockets. Unlike `worker.ts` it runs
 * `dbManager.init()` with `checkForLegacyInstall` in effect: the *destination* must be a current 3.0
 * schema. The 2.x source is read through `SourceConnector` instead and never sees that check.
 */

import fs from 'node:fs/promises'
import {
  bootstrapMigrationRuntime,
  buildSourceConnector,
  resolveUsersImportContext
} from '../migration/bootstrap.ts'
import { parseMigrationArgs } from '../migration/cli.ts'
import { computeExitCode, notImplementedPhaseIds } from '../migration/exit-status.ts'
import { MIGRATION_PHASES } from '../migration/phases/index.ts'
import { runMigration } from '../migration/orchestrator.ts'
import {
  emptyPhaseReport,
  formatPostMigrationNotices,
  formatReportTable,
  POST_MIGRATION_NOTICES,
  reportsToJson
} from '../migration/report.ts'
import type { MigrationContext } from '../migration/context.ts'
import type { ParsedMigrationArgs } from '../migration/cli.ts'

async function main(): Promise<void> {
  const args = parseMigrationArgs(process.argv.slice(2))

  const CARDINAL = await bootstrapMigrationRuntime('migrate-cli')

  // -> No `source` field: `args.source` is a whole `ParsedSource`, credentials included.
  CARDINAL.logger.info('migrate', '2.5.x -> 3.0 migration cli', {
    site: args.siteId,
    dryRun: args.dryRun
  })

  // An open pg Pool keeps the event loop alive, and unlike index.ts's server nothing else here does:
  // without closing it the CLI finishes its work but never returns control to whoever ran it.
  try {
    await runAgainstDestination(CARDINAL, args)
  } finally {
    await CARDINAL.dbManager.pool?.end()
  }
}

/**
 * Resolves `'auto'` before a `MigrationContext` is ever built, which is what keeps `phases/content.ts`
 * ignorant of Puppeteer and `renderQueue` entirely. An explicit `'queue'`/`'passthrough'` passes
 * through unchanged: an operator who asked for `'queue'` gets the per-page `renderPuppeteerMissing`
 * refusal from `createPage()` if this destination has no Puppeteer, not a silent fallback.
 *
 * `'passthrough'` keeps 2.x's stored render, whose image `src`es do not carry 3.0's `/_files/`
 * convention — they resolve in the editor's live preview (which re-renders `content`) but not on the
 * published page, which serves the stored blob as-is.
 */
async function resolveRenderMode(
  CARDINAL: CardinalGlobal,
  requested: ParsedMigrationArgs['renderMode']
): Promise<'passthrough' | 'queue'> {
  if (requested !== 'auto') {
    return requested
  }
  const available = await CARDINAL.models.renderQueue.isAvailable()
  if (!available) {
    CARDINAL.logger.info(
      'migrate',
      'render-mode auto: no Puppeteer extension on this destination, so imported pages will carry ' +
        "2.x's stored render through unchanged (2.x's own asset-URL convention, not 3.0's " +
        '"/_files/" one) until re-rendered by hand afterwards (Admin > Pages > select all > Re-render)'
    )
    return 'passthrough'
  }
  CARDINAL.logger.info(
    'migrate',
    'render-mode auto: this destination can render pages natively, so imported markdown pages will ' +
      "be queued for a real 3.0 render instead of carrying 2.x's stored render through unchanged"
  )
  return 'queue'
}

async function runAgainstDestination(
  CARDINAL: CardinalGlobal,
  args: ParsedMigrationArgs
): Promise<void> {
  const site = await CARDINAL.models.sites.getSiteById({ id: args.siteId, forceReload: true })
  if (!site) {
    CARDINAL.logger.error('migrate', 'destination site was not found', { site: args.siteId })
    process.exitCode = 1
    return
  }

  const source = buildSourceConnector(args.source)
  await source.connect()
  try {
    const description = await source.describe()
    CARDINAL.logger.info('migrate', 'source connected', {
      kind: description.kind,
      location: description.location,
      ...(description.version ? { detectedVersion: description.version } : {})
    })
    for (const note of description.notes) {
      CARDINAL.logger.info('migrate', note)
    }

    const ctx: MigrationContext = {
      db: CARDINAL.db,
      source,
      siteId: args.siteId,
      dryRun: args.dryRun,
      log: (message) => CARDINAL.logger.info('migrate', message),
      renderMode: await resolveRenderMode(CARDINAL, args.renderMode),
      ...resolveUsersImportContext(CARDINAL)
    }

    const results = await runMigration(MIGRATION_PHASES, ctx, { only: args.only })

    for (const result of results) {
      CARDINAL.logger.info('migrate', `phase ${result.phase} ${result.status}`, {
        ...result.counts,
        ...(result.notImplemented?.length
          ? { notImplemented: result.notImplemented.join(',') }
          : {})
      })
      if (result.errors?.length) {
        for (const message of result.errors) {
          CARDINAL.logger.error('migrate', message, { phase: result.phase })
        }
      }
    }

    const reports = results.map((result) => result.report ?? emptyPhaseReport(result.phase))
    process.stdout.write(`\n${formatReportTable(reports)}\n`)
    if (args.reportFile) {
      await fs.writeFile(args.reportFile, `${reportsToJson(reports)}\n`, 'utf8')
      CARDINAL.logger.info('migrate', 'report written', { path: args.reportFile })
    }

    // A record class no phase reads at all (2.x API tokens, Slack/Discord notification config) has
    // nothing to feed the per-record `unmappable` mechanism, so these static notices are the only
    // place an operator learns it did not carry forward.
    const noticesText = formatPostMigrationNotices(POST_MIGRATION_NOTICES)
    if (noticesText) {
      process.stdout.write(`\n${noticesText}\n`)
    }

    const notImplementedPhases = notImplementedPhaseIds(results)
    if (!args.dryRun && notImplementedPhases.length > 0) {
      CARDINAL.logger.error(
        'migrate',
        `live migration incomplete: these phases had no real write path against this source and ` +
          `wrote nothing. Whatever phases DID write above already made real changes to the ` +
          `destination — this is not a rollback, just a signal that the migration is only partially ` +
          `done. Re-run with a source that implements the missing phases (a bundle source cannot ` +
          `import ${notImplementedPhases.join('/')} at all yet), or pass --only to target just the ` +
          `phases that need it`,
        { phases: notImplementedPhases.join(',') }
      )
    }

    process.exitCode = computeExitCode(results, args.dryRun)
  } finally {
    await source.disconnect()
  }
}

main().catch((err: any) => {
  console.error(err.stack ?? err.message ?? err)
  process.exitCode = 1
})
