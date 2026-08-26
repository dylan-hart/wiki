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
import { bootstrapMigrationRuntime, buildSourceConnector } from '../migration/bootstrap.ts'
import { parseMigrationArgs, refusalReason } from '../migration/cli.ts'
import { MIGRATION_PHASES } from '../migration/phases/index.ts'
import { runMigration } from '../migration/orchestrator.ts'
import { createProvenanceStore } from '../migration/provenance.ts'
import { formatReportTable, reportsToJson } from '../migration/render.ts'
import { emptyPhaseReport } from '../migration/report.ts'
import type { MigrationContext } from '../migration/context.ts'
import type { ParsedMigrationArgs } from '../migration/cli.ts'

async function main(): Promise<void> {
  const args = parseMigrationArgs(process.argv.slice(2))

  // 2026-08-24 audit, correctness-migration.md §2 (WP #1797, part of epic #1788): no phase can write
  // to the destination yet, so a non-`--dry-run` invocation is refused outright, before anything --
  // including `bootstrapMigrationRuntime` -- touches the destination database. Checked here rather
  // than folded into `parseMigrationArgs` so the refusal prints as a clean one-liner instead of the
  // stack-trace-shaped output `main().catch()` below gives a genuine parse error.
  const refusal = refusalReason(args)
  if (refusal) {
    console.error(refusal)
    process.exitCode = 1
    return
  }

  const WIKI = await bootstrapMigrationRuntime('migrate-cli')

  WIKI.logger.info('=======================================')
  WIKI.logger.info('= Wiki.js 2.5.x -> 3.0 Migration CLI  =')
  WIKI.logger.info('=======================================')
  // Unconditional, not gated on `args.dryRun`: the refusal above guarantees every run reaching this
  // line already IS a dry run, and the banner should say so truthfully regardless -- it must never
  // again read as "no news means writes are happening".
  WIKI.logger.info(
    'Report-only mode: no migration phase can write to the destination yet; nothing will be written.'
  )
  if (args.updateExisting) {
    WIKI.logger.info(
      'Update-existing: an already-imported row will be updated in place, not skipped.'
    )
  }

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

async function runAgainstDestination(WIKI: WikiGlobal, args: ParsedMigrationArgs): Promise<void> {
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
