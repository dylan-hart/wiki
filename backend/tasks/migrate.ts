/* eslint-disable no-console -- CLI entry point: the `usage:` text and the fatal-exit lines are stdout/stderr for a person at a terminal, not log records. */
/**
 * Wiki.js 2.5.x -> 3.0 migration CLI.
 *
 * Standalone entry point: run via `node backend/tasks/migrate.ts <args>` or `npm run migrate --
 * <args>` from `backend/`. Deliberately never imported by `index.ts`, `worker.ts`, or
 * `core/scheduler.ts`'s `tasks/simple/` discovery — this opens a second, *foreign* (2.x) database
 * connection alongside the 3.0 destination, which nothing else in this codebase does or should do.
 *
 * The bootstrap (`../migration/bootstrap.ts`) is modeled on `worker.ts`'s minimal `WIKI` global, not
 * `index.ts`'s full boot: no HTTP server, no scheduler, no cache, no collab websockets — just enough
 * to talk to the 3.0 destination database and run the model methods each import phase needs. It is
 * shared with `verify-migration.ts` (Feature 421 task 748), which needs the exact same runtime for
 * post-import verification. Unlike `worker.ts`, this legitimately runs `dbManager.init()` with
 * `checkForLegacyInstall` still in effect: the *destination* must be a current 3.0 schema, so
 * refusing a 2.x-shaped destination is exactly the right check here, only ever run against the
 * destination, never the 2.x source (which is read through the separate `SourceConnector` interface
 * — Feature 412 — and is expected to look like a 2.x database).
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
import { emptyPhaseReport, formatReportTable, reportsToJson } from '../migration/report.ts'
import type { MigrationContext } from '../migration/context.ts'
import type { ParsedMigrationArgs } from '../migration/cli.ts'

async function main(): Promise<void> {
  const args = parseMigrationArgs(process.argv.slice(2))

  const WIKI = await bootstrapMigrationRuntime('migrate-cli')

  // -> No `source` field: `args.source` is a whole `ParsedSource`, credentials included. The source
  //    is described (kind and location only) by `runAgainstDestination` below.
  WIKI.logger.info('migrate', '2.5.x -> 3.0 migration cli', {
    site: args.siteId,
    dryRun: args.dryRun
  })

  // Unlike index.ts's server, this process has nothing else keeping the event loop alive once it's
  // done — an open pg Pool does, though, so without closing it here the CLI would exit its own logic
  // but never actually return control to whoever ran it (a real bug an operator would hit on every
  // invocation, dry-run or not).
  try {
    await runAgainstDestination(WIKI, args)
  } finally {
    await WIKI.dbManager.pool?.end()
  }
}

/**
 * Resolves `--render-mode`'s `'auto'` (the default) into a concrete `'queue'`/`'passthrough'` before a
 * `MigrationContext` is ever built — `phases/content.ts` itself never checks Puppeteer availability
 * (see `context.ts`'s `renderMode` doc for why: keeping that phase ignorant of Puppeteer/`renderQueue`
 * keeps its own tests, and this file's `entities()` synchronous-return contract, unaffected). `'queue'`/
 * `'passthrough'` given explicitly pass straight through unchanged — an operator who explicitly asked
 * for `'queue'` gets exactly that, including the `renderPuppeteerMissing` refusal `createPage()`'s own
 * `ensureCanRender()` throws per page if this destination turns out not to have Puppeteer after all,
 * rather than a silent, unrequested fallback to `'passthrough'`.
 *
 * This is what fixes the migration's own long-standing default gap (2.5.x's already-rendered HTML
 * carried straight through onto a destination whose asset-serving convention it does not match — a
 * `/_files/`-less image `src` that renders in the editor's live preview, which resolves `content`
 * fresh, but not on the published page, which serves this stale `render` blob as-is): a fresh
 * destination almost always has Puppeteer (the Dockerfile installs the distro Chromium package it
 * needs unconditionally), so `'auto'` gets a real, correct 3.0 render for every markdown page without
 * the operator having to know this distinction exists at all.
 */
async function resolveRenderMode(
  WIKI: WikiGlobal,
  requested: ParsedMigrationArgs['renderMode']
): Promise<'passthrough' | 'queue'> {
  if (requested !== 'auto') {
    return requested
  }
  const available = await WIKI.models.renderQueue.isAvailable()
  if (!available) {
    WIKI.logger.info(
      'migrate',
      'render-mode auto: no Puppeteer extension on this destination, so imported pages will carry ' +
        "2.x's stored render through unchanged (2.x's own asset-URL convention, not 3.0's " +
        '"/_files/" one) until re-rendered by hand afterwards (Admin > Pages > select all > Re-render)'
    )
    return 'passthrough'
  }
  WIKI.logger.info(
    'migrate',
    'render-mode auto: this destination can render pages natively, so imported markdown pages will ' +
      "be queued for a real 3.0 render instead of carrying 2.x's stored render through unchanged"
  )
  return 'queue'
}

async function runAgainstDestination(WIKI: WikiGlobal, args: ParsedMigrationArgs): Promise<void> {
  const site = await WIKI.models.sites.getSiteById({ id: args.siteId, forceReload: true })
  if (!site) {
    WIKI.logger.error('migrate', 'destination site was not found', { site: args.siteId })
    process.exitCode = 1
    return
  }

  const source = buildSourceConnector(args.source)
  await source.connect()
  try {
    const description = await source.describe()
    WIKI.logger.info('migrate', 'source connected', {
      kind: description.kind,
      location: description.location,
      ...(description.version ? { detectedVersion: description.version } : {})
    })
    for (const note of description.notes) {
      WIKI.logger.info('migrate', note)
    }

    const ctx: MigrationContext = {
      db: WIKI.db,
      source,
      siteId: args.siteId,
      dryRun: args.dryRun,
      log: (message) => WIKI.logger.info('migrate', message),
      renderMode: await resolveRenderMode(WIKI, args.renderMode),
      ...resolveUsersImportContext(WIKI)
    }

    const results = await runMigration(MIGRATION_PHASES, ctx, { only: args.only })

    for (const result of results) {
      WIKI.logger.info('migrate', `phase ${result.phase} ${result.status}`, {
        ...result.counts,
        ...(result.notImplemented?.length
          ? { notImplemented: result.notImplemented.join(',') }
          : {})
      })
      if (result.errors?.length) {
        for (const message of result.errors) {
          WIKI.logger.error('migrate', message, { phase: result.phase })
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
      WIKI.logger.info('migrate', 'report written', { path: args.reportFile })
    }

    // -> Whole-branch review Important #4: a live (non-dry-run) run must exit non-zero, with a clear
    //    message naming which phase(s), when any phase had no real write path at all against the
    //    source in use — see `../migration/exit-status.ts`'s own doc comment for the full "why" (a
    //    bundle source's still-stubbed phases used to silently exit 0 on a real, partial migration).
    const notImplementedPhases = notImplementedPhaseIds(results)
    if (!args.dryRun && notImplementedPhases.length > 0) {
      WIKI.logger.error(
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
