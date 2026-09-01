import { definePhase } from './define-phase.ts'
import type { SourceRecord } from '../connector.ts'

/**
 * Phase 3 (Feature 416: content importer). Depends on `users`: every page/history row carries an
 * `authorId`/`creatorId` that must resolve to an already-imported destination user.
 *
 * `pageHistory` and `tags` are not given a `classify` here: a history row's identity is inseparable
 * from the page it revises, and a tag's from the pages that carry it, so both are left as plain "would
 * create" counts until Feature 416 defines what idempotency means for them specifically.
 */
export const contentPhase = definePhase({
  id: 'content',
  label: 'Pages, page history & tags',
  dependsOn: ['users'],
  entities: (ctx) => ({
    pages: {
      source: () => ctx.source.pages(),
      classify: async (record, recorder) => {
        const page = record as SourceRecord
        const path = typeof page.path === 'string' ? page.path : undefined
        const identifier = path ?? String(page.id ?? 'unknown')
        await recorder.create(identifier)
      }
    },
    pageHistory: { source: () => ctx.source.pageHistory() },
    tags: { source: () => ctx.source.tags() }
  })
})
