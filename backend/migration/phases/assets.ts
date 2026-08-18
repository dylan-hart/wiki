import { definePhase } from './define-phase.ts'

/**
 * Phase 4 (Feature 418: assets/comments-staging importer). Depends on `content`: assets are attached
 * to pages, so the pages they belong to must already exist at the destination.
 */
export const assetsPhase = definePhase({
  id: 'assets',
  label: 'Assets & comments-staging',
  dependsOn: ['content'],
  entities: (ctx) => ({
    assets: () => ctx.source.assets()
  })
})
