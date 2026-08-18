import {
  reconcileNaturalKeyMatch,
  resolveExisting,
  SOURCE_SYSTEM_WIKIJS_2_5X
} from '../provenance.ts'
import { definePhase } from './define-phase.ts'
import type { SourceRecord } from '../connector.ts'
import type { MigrationContext } from '../context.ts'
import type { WriteRecorder } from '../recorder.ts'

/**
 * Classifies one `pages` record via Feature 421 task 746's provenance/idempotency check: the exact
 * `migrationRecords` lookup first, falling back to a natural-key match on `(siteId, locale, path)` for
 * the interrupted-run edge case `../provenance.ts` documents. See `../phases/users.ts`'s `classifyUser`
 * for why this is the read-only `resolveExisting` half rather than the full `lookupOrInsert` — there is
 * no real page-creation write yet for a genuine miss to call (Feature 416 owns that).
 *
 * `pageHistory` and `tags` are not given a `classify` here: a history row's identity is inseparable
 * from the page it revises, and a tag's from the pages that carry it, so both are left as plain "would
 * create" counts until Feature 416 defines what idempotency means for them specifically.
 */
async function classifyPage(
  record: unknown,
  recorder: WriteRecorder,
  ctx: MigrationContext
): Promise<void> {
  const page = record as SourceRecord
  const path = typeof page.path === 'string' ? page.path : undefined
  const locale = typeof page.localeCode === 'string' ? page.localeCode : 'en'
  const identifier = path ?? String(page.id ?? 'unknown')

  if (!path) {
    await recorder.create(identifier)
    return
  }

  const key = {
    siteId: ctx.siteId,
    sourceSystem: SOURCE_SYSTEM_WIKIJS_2_5X,
    sourceTable: 'pages',
    sourceId: String(page.id ?? path)
  }
  const existing = await resolveExisting(ctx.provenanceStore, key, () =>
    ctx.provenanceStore.findExistingPageByPath(ctx.siteId, locale, path)
  )
  if (existing) {
    if (existing.viaNaturalKey && !ctx.dryRun) {
      await reconcileNaturalKeyMatch(ctx.provenanceStore, key, 'pages', existing.destId)
    }
    recorder.skipExisting(identifier)
    return
  }
  await recorder.create(identifier)
}

/**
 * Phase 3 (Feature 416: content importer). Depends on `users`: every page/history row carries an
 * `authorId`/`creatorId` that must resolve to an already-imported destination user.
 */
export const contentPhase = definePhase({
  id: 'content',
  label: 'Pages, page history & tags',
  dependsOn: ['users'],
  entities: (ctx) => ({
    pages: {
      source: () => ctx.source.pages(),
      classify: (record, recorder) => classifyPage(record, recorder, ctx)
    },
    pageHistory: { source: () => ctx.source.pageHistory() },
    tags: { source: () => ctx.source.tags() }
  })
})
