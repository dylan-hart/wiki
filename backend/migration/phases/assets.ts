import { importAsset } from '../importers/asset-import.ts'
import {
  createCommentImportState,
  importComment,
  resolveCommentReplies
} from '../importers/comment-import.ts'
import { resolvePrimaryLocale } from '../context.ts'
import { definePhase } from './define-phase.ts'
import { placeholderRow, writeUnlessDryRun } from './dry-run.ts'
import { routeOutcome } from './route.ts'
import type { SourceAssetFile, SourceRecord } from '../connector.ts'
import type {
  AssetImportDeps,
  AssetImportFailure,
  AssetImportOptions,
  AssetsWriteModel,
  TreeFolderModel
} from '../importers/asset-import.ts'
import type {
  CommentImportDeps,
  CommentImportFailure,
  CommentImportOptions,
  CommentsWriteModel
} from '../importers/comment-import.ts'
import type { RecordOutcome } from './route.ts'

/**
 * Maps an `importAsset()`/`importComment()` outcome onto the buckets `./route.ts` routes. Neither
 * importer has a "skipped" outcome of its own: an asset or comment either creates or conflicts.
 */
function toRecordOutcome(
  outcome: { result: 'success' } | { result: 'failure'; failure: { message: string } }
): RecordOutcome {
  return outcome.result === 'success'
    ? { outcome: 'created' }
    : { outcome: 'conflicted', detail: outcome.failure.message }
}

/**
 * Depends on `content`: an asset's folder placement and a comment's `pageId` both resolve against
 * pages that phase creates, through `ctx.pageIdMap`.
 *
 * `assets` and `comments` are independent of each other — a comment resolves its `pageId` through
 * `ctx.pageIdMap`, already fully populated before this phase starts, not through anything `assets`
 * itself produces — so entity order between the two does not matter. `comments` alone carries a
 * second pass: its `onComplete` hook resolves every reply whose parent comment appeared later in the
 * same stream. An asset's folder placement never depends on another asset that way.
 *
 * Dry run: each of `assetsModel`/`treeModel`/`commentsModel` checks `ctx.dryRun` *inside* its own
 * method body before ever touching the ambient `CARDINAL` global, minting a placeholder id instead, so
 * a dry run touches `CARDINAL` nowhere at all while the importers' own classification logic (folder
 * resolution, actor fallback, missing-page detection) still runs identically in both modes.
 */
export const assetsPhase = definePhase({
  id: 'assets',
  label: 'Assets & comments',
  dependsOn: ['content'],
  entities: (ctx) => {
    // Neither map exists until its owning phase has run, so an empty map is the right fallback for a
    // hand-built context that never ran `users`/`content`: every asset authorId falls back to the
    // operator actor and every comment's pageId reports as 'unknown-page' rather than crashing.
    const userIdMap = ctx.userIdMap ?? new Map<number, string>()
    const pageIdMap = ctx.pageIdMap ?? new Map<number, string>()

    const assetsModel: AssetsWriteModel = {
      upload: (input) =>
        writeUnlessDryRun(
          ctx.dryRun,
          () => ({ ...placeholderRow(), fileName: input.fileName }),
          () => CARDINAL.models.assets.upload(input)
        )
    }
    const treeModel: TreeFolderModel = {
      getFolder: (input) =>
        writeUnlessDryRun(ctx.dryRun, placeholderRow, () => CARDINAL.models.tree.getFolder(input))
    }
    const assetDeps: AssetImportDeps = { assetsModel, treeModel }
    const assetOptions: AssetImportOptions = {
      siteId: ctx.siteId,
      // -> Read fresh off CARDINAL.sites, not a value snapshotted before any phase ran. Safe to
      //    resolve here at entities()-construction time rather than inside a dry-run-gated closure:
      //    resolvePrimaryLocale() internalizes that gate itself, and the phases it reads behind have
      //    already run by then.
      locale: resolvePrimaryLocale(ctx),
      userIdMap,
      fallbackActorId: ctx.operatorActorId
    }

    const commentsModel: CommentsWriteModel = {
      create: (input) =>
        writeUnlessDryRun(ctx.dryRun, placeholderRow, () => CARDINAL.models.comments.create(input)),
      setReplyTo: (id, replyTo) =>
        writeUnlessDryRun(
          ctx.dryRun,
          () => undefined,
          () => CARDINAL.models.comments.setReplyTo(id, replyTo)
        )
    }
    const commentDeps: CommentImportDeps = { commentsModel }
    const commentOptions: CommentImportOptions = {
      siteId: ctx.siteId,
      pageIdMap,
      userIdMap
    }
    // -> Live reference: `importComment()` populates it as each comment is written, and
    //    `resolveCommentReplies()` reads it once the whole stream is exhausted.
    const commentState = createCommentImportState()

    return {
      assets: {
        source: () => ctx.source.assets(),
        classify: async (record, recorder) => {
          const file = record as SourceAssetFile
          const identifier = typeof file?.relativePath === 'string' ? file.relativePath : 'unknown'
          const outcome = await importAsset(file, assetDeps, assetOptions)
          if (outcome.result === 'success') {
            for (const warning of outcome.success.warnings) {
              ctx.log?.(warning)
            }
          } else {
            const failure: AssetImportFailure = outcome.failure
            ctx.log?.(`asset ${failure.relativePath}: ${failure.reason} — ${failure.message}`)
          }
          await routeOutcome(recorder, identifier, toRecordOutcome(outcome))
        }
      },
      comments: {
        source: () => ctx.source.comments(),
        classify: async (record, recorder) => {
          const source = record as SourceRecord
          const identifier = String(source.id ?? 'unknown')
          const outcome = await importComment(source, commentDeps, commentOptions, commentState)
          if (outcome.result === 'failure') {
            const failure: CommentImportFailure = outcome.failure
            ctx.log?.(`comment ${failure.oldId}: ${failure.reason} — ${failure.message}`)
          }
          await routeOutcome(recorder, identifier, toRecordOutcome(outcome))
        },
        onComplete: () => resolveCommentReplies(commentDeps, commentState, ctx.log)
      }
    }
  }
})
