import { COMMENTS_UNMAPPABLE } from '../unmappable.ts'
import { definePhase } from './define-phase.ts'

/**
 * Phase 4 (Feature 418: assets/comments-staging importer). Depends on `content`: assets are attached
 * to pages, so the pages they belong to must already exist at the destination.
 *
 * `staticUnmappable` always reports comments as unmappable (see `../unmappable.ts`'s
 * `COMMENTS_UNMAPPABLE`) — 3.0 has no destination table for them yet (blocked on Epic 335), and the
 * `SourceConnector` interface has no `comments()` generator to read through in the first place, so
 * this is a structural note rather than something derived from a count.
 */
export const assetsPhase = definePhase({
  id: 'assets',
  label: 'Assets & comments-staging',
  dependsOn: ['content'],
  entities: (ctx) => ({
    assets: { source: () => ctx.source.assets() }
  }),
  staticUnmappable: [COMMENTS_UNMAPPABLE]
})
