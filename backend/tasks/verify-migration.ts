/* eslint-disable no-console -- CLI entry point: the `usage:` text and the fatal-exit lines are stdout/stderr for a person at a terminal, not log records. */
/**
 * Wiki.js 2.5.x -> 3.0 migration verification — Feature 421 task 748.
 *
 * Standalone entry point, run *after* a real (non-dry-run) `migrate.ts` import: `node
 * backend/tasks/verify-migration.ts <args>` or `npm run verify-migration -- <args>` from `backend/`.
 * Shares `migrate.ts`'s bootstrap (`../migration/bootstrap.ts`) rather than duplicating it — the same
 * minimal, HTTP-server-less `WIKI` runtime, connected to the same 3.0 destination and reading through
 * the same kind of `SourceConnector`. Deliberately never imported by `index.ts`, `worker.ts`, or
 * `core/scheduler.ts`'s `tasks/simple/` discovery, for the same reason `migrate.ts` is not: this opens
 * a second, *foreign* (2.x) database connection alongside the 3.0 destination.
 *
 * Two independent checks (`../migration/verify.ts` has the full rationale):
 *   1. Per-entity source-vs-destination record counts, optionally cross-checked against a dry-run
 *      report captured before the import (`--against-report`, from `migrate.ts --report-file`).
 *   2. A content-integrity spot-check hash-comparing a sample of pages' rendered bodies.
 *
 * Prints a pass/fail summary suitable for pasting into the cutover runbook's verification step (task
 * 751), and exits non-zero when the summary's outcome is `'fail'`.
 */

import { bootstrapMigrationRuntime, buildSourceConnector } from '../migration/bootstrap.ts'
import { parseVerifyArgs } from '../migration/verify-cli.ts'
import {
  compareAgainstDryRunReports,
  compareEntityCounts,
  countDestinationEntities,
  countPhaseOnlySourceCounts,
  countSourceEntities,
  createDestinationCounter,
  createDestinationPageLookup,
  formatVerifySummary,
  runContentSpotCheck
} from '../migration/verify.ts'
import type { ParsedVerifyArgs } from '../migration/verify-cli.ts'
import type { PhaseReport } from '../migration/report.ts'

async function main(): Promise<void> {
  const args = parseVerifyArgs(process.argv.slice(2))

  const WIKI = await bootstrapMigrationRuntime('verify-migration-cli')

  WIKI.logger.info('migrate', '2.5.x -> 3.0 migration verify', { site: args.siteId })

  try {
    await runVerification(WIKI, args)
  } finally {
    await WIKI.dbManager.pool?.end()
  }
}

async function loadDryRunReports(reportFile: string | undefined): Promise<PhaseReport[]> {
  if (!reportFile) {
    return []
  }
  const fs = await import('node:fs/promises')
  const raw = await fs.readFile(reportFile, 'utf8')
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`"${reportFile}" does not contain a JSON array of phase reports.`)
  }
  return parsed as PhaseReport[]
}

async function runVerification(WIKI: WikiGlobal, args: ParsedVerifyArgs): Promise<void> {
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

    WIKI.logger.info('migrate', 'counting source records')
    const sourceCounts = await countSourceEntities(source)
    const phaseOnlyCounts = await countPhaseOnlySourceCounts(source)

    WIKI.logger.info('migrate', 'counting destination records')
    const destinationCounts = await countDestinationEntities(
      createDestinationCounter(WIKI.db),
      args.siteId
    )

    const entityCounts = compareEntityCounts(sourceCounts, destinationCounts)

    const dryRunReports = await loadDryRunReports(args.againstReport)
    const phaseComparisons = compareAgainstDryRunReports(
      sourceCounts,
      phaseOnlyCounts,
      dryRunReports
    )

    WIKI.logger.info(
      'migrate',
      'running content spot-check',
      args.samplePaths ? { paths: args.samplePaths.length } : { sample: args.sampleSize }
    )
    const spotCheck = await runContentSpotCheck(source, createDestinationPageLookup(WIKI.db), {
      siteId: args.siteId,
      paths: args.samplePaths,
      sampleSize: args.sampleSize
    })

    const summary = formatVerifySummary({ entityCounts, phaseComparisons, spotCheck })
    process.stdout.write(`\n${summary.text}\n`)
    WIKI.logger.info('migrate', 'verification finished', { outcome: summary.outcome })

    process.exitCode = summary.outcome === 'fail' ? 1 : 0
  } finally {
    await source.disconnect()
  }
}

main().catch((err: any) => {
  console.error(err.stack ?? err.message ?? err)
  process.exitCode = 1
})
