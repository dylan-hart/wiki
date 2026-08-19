import { resolveExisting, SOURCE_SYSTEM_WIKIJS_2_5X } from '../provenance.ts'
import { COMMENTS_UNMAPPABLE } from '../unmappable.ts'
import { definePhase } from './define-phase.ts'
import type { MigrationContext } from '../context.ts'
import type { SourceAssetFile } from '../connector.ts'
import type { WriteRecorder } from '../recorder.ts'

/**
 * Classifies one asset file via Feature 421 task 746's provenance/idempotency check — the exact
 * `migrationRecords` lookup only, deliberately with **no** natural-key fallback wired in here yet.
 *
 * `../provenance.ts`'s `ProvenanceStore.findExistingAssetByFolderAndFilename()` exists and is ready
 * for this call site, but the natural key it needs is the 3.0 `(siteId, folderPath, fileName)` — and
 * the 2.x source only gives an asset a numeric `folderId` (`docs/migration/2.5x-source-schema.md`'s
 * `assets` table), which requires walking `assetFolders` to resolve into a full ltree path. That walk
 * is genuinely Feature 418's own transform logic to write, not something to improvise here; until it
 * exists, a row this misses on (a prior run interrupted after creating the destination asset but
 * before its provenance row) falls through to `create()` uncaught, exactly like before this task. Wire
 * `findByNaturalKey` in here once Feature 418 can produce a resolved folder path.
 */
async function classifyAsset(
  file: SourceAssetFile,
  recorder: WriteRecorder,
  ctx: MigrationContext
): Promise<void> {
  const identifier = typeof file?.relativePath === 'string' ? file.relativePath : 'unknown'
  const existing = await resolveExisting(ctx.provenanceStore, {
    siteId: ctx.siteId,
    sourceSystem: SOURCE_SYSTEM_WIKIJS_2_5X,
    sourceTable: 'assets',
    sourceId: identifier
  })
  if (existing) {
    recorder.skipExisting(identifier)
    return
  }
  await recorder.create(identifier)
}

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
    assets: {
      source: () => ctx.source.assets(),
      classify: (record, recorder) => classifyAsset(record as SourceAssetFile, recorder, ctx)
    }
  }),
  staticUnmappable: [COMMENTS_UNMAPPABLE]
})
