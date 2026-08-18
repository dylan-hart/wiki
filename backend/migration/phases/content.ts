import { definePhase } from './define-phase.ts'

/**
 * Phase 3 (Feature 416: content importer). Depends on `users`: every page/history row carries an
 * `authorId`/`creatorId` that must resolve to an already-imported destination user.
 */
export const contentPhase = definePhase({
  id: 'content',
  label: 'Pages, page history & tags',
  dependsOn: ['users'],
  entities: (ctx) => ({
    pages: { source: () => ctx.source.pages() },
    pageHistory: { source: () => ctx.source.pageHistory() },
    tags: { source: () => ctx.source.tags() }
  })
})
