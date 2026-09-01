import { COMMENTS_UNMAPPABLE } from '../unmappable.ts'
import { definePhase } from './define-phase.ts'
import type { SourceAssetFile } from '../connector.ts'
import type { WriteRecorder } from '../recorder.ts'

/** Classifies one asset file: the destination is always empty (single fresh install), so every asset
 * read off the source is a would-create candidate — there is no "already imported" case to detect. */
async function classifyAsset(file: SourceAssetFile, recorder: WriteRecorder): Promise<void> {
  const identifier = typeof file?.relativePath === 'string' ? file.relativePath : 'unknown'
  await recorder.create(identifier)
}

/**
 * Phase 4 (Feature 418: assets/comments-staging importer). Depends on `content`: assets are attached
 * to pages, so the pages they belong to must already exist at the destination.
 *
 * `staticUnmappable` always reports comments as unmappable (see `../unmappable.ts`'s
 * `COMMENTS_UNMAPPABLE`) — not because 3.0 lacks a comments table (it doesn't; comments have shipped),
 * but because the `SourceConnector` interface has no `comments()` generator to read 2.x comments
 * through in the first place, so this is a structural note rather than something derived from a count.
 */
export const assetsPhase = definePhase({
  id: 'assets',
  label: 'Assets & comments-staging',
  dependsOn: ['content'],
  entities: (ctx) => ({
    assets: {
      source: () => ctx.source.assets(),
      classify: (record, recorder) => classifyAsset(record as SourceAssetFile, recorder)
    }
  }),
  staticUnmappable: [COMMENTS_UNMAPPABLE]
})
