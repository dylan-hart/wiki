/* eslint-disable no-console -- CLI entry point: the `usage:` text and the fatal-exit lines are stdout/stderr for a person at a terminal, not log records. */
/**
 * Standalone CLI, run *after* a real (non-dry-run) `migrate.ts` import. Like `migrate.ts`, it must
 * never be imported by `index.ts`, `worker.ts` or `core/scheduler.ts`'s `tasks/simple/` discovery:
 * it opens a second, *foreign* (2.x) database connection alongside the 3.0 destination.
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

  const CARDINAL = await bootstrapMigrationRuntime('verify-migration-cli')

  CARDINAL.logger.info('migrate', '2.5.x -> 3.0 migration verify', { site: args.siteId })

  try {
    await runVerification(CARDINAL, args)
  } finally {
    await CARDINAL.dbManager.pool?.end()
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

async function runVerification(CARDINAL: CardinalGlobal, args: ParsedVerifyArgs): Promise<void> {
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

    CARDINAL.logger.info('migrate', 'counting source records')
    const sourceCounts = await countSourceEntities(source)
    const phaseOnlyCounts = await countPhaseOnlySourceCounts(source)

    CARDINAL.logger.info('migrate', 'counting destination records')
    const destinationCounts = await countDestinationEntities(
      createDestinationCounter(CARDINAL.db),
      args.siteId
    )

    const entityCounts = compareEntityCounts(sourceCounts, destinationCounts)

    const dryRunReports = await loadDryRunReports(args.againstReport)
    const phaseComparisons = compareAgainstDryRunReports(
      sourceCounts,
      phaseOnlyCounts,
      dryRunReports
    )

    CARDINAL.logger.info(
      'migrate',
      'running content spot-check',
      args.samplePaths ? { paths: args.samplePaths.length } : { sample: args.sampleSize }
    )
    const spotCheck = await runContentSpotCheck(source, createDestinationPageLookup(CARDINAL.db), {
      siteId: args.siteId,
      paths: args.samplePaths,
      sampleSize: args.sampleSize
    })

    const summary = formatVerifySummary({ entityCounts, phaseComparisons, spotCheck })
    process.stdout.write(`\n${summary.text}\n`)
    CARDINAL.logger.info('migrate', 'verification finished', { outcome: summary.outcome })

    process.exitCode = summary.outcome === 'fail' ? 1 : 0
  } finally {
    await source.disconnect()
  }
}

main().catch((err: any) => {
  console.error(err.stack ?? err.message ?? err)
  process.exitCode = 1
})
