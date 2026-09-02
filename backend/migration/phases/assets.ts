import { importAsset } from '../importers/asset-import.ts'
import { importComment } from '../importers/comment-import.ts'
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
 * Maps an `importAsset()`/`importComment()` outcome onto the buckets `./route.ts` routes — see that
 * module's own doc comment for why the write already happened by the time this runs. Neither importer
 * has a "skipped" outcome of its own: an asset or comment either creates or conflicts.
 */
function toRecordOutcome(
  outcome: { result: 'success' } | { result: 'failure'; failure: { message: string } }
): RecordOutcome {
  return outcome.result === 'success'
    ? { outcome: 'created' }
    : { outcome: 'conflicted', detail: outcome.failure.message }
}

/**
 * Phase 4 (Feature 418: assets/comments importer). Depends on `content`: an asset's folder placement
 * and a comment's `pageId` both resolve against pages the `content` phase must have already
 * created — `ctx.pageIdMap`, a live reference populated as that phase's `pages` entity runs (see
 * `context.ts`'s own doc comment on the field).
 *
 * This phase wires `importers/asset-import.ts` (`importAsset()`, driving
 * `models/tree.ts#getFolder({ createIfMissing: true })` then `models/assets.ts#upload()`) and
 * `importers/comment-import.ts` (`importComment()`, driving `models/comments.ts#create()`).
 *
 * `assets` and `comments` are independent entities (unlike `content`'s strictly-sequential `pages` then
 * `navigation`) — comments resolve `pageId` through `ctx.pageIdMap`, which is already fully populated
 * once this phase starts (the `content` phase this one `dependsOn` has already finished), not through
 * anything `assets` itself produces, so entity order between the two does not matter here.
 *
 * ## Dry run
 *
 * Same split `phases/content.ts`'s `pagesModel`/`navigationModel` use: each of `assetsModel`/
 * `treeModel`/`commentsModel` below checks `ctx.dryRun` *inside* its own method body before ever
 * touching the ambient `WIKI` global, minting a placeholder id instead — so a `dryRun: true` run's
 * `entities()` construction touches `WIKI` nowhere at all, and `importAsset()`/`importComment()`'s own
 * real classification logic (folder resolution, actor fallback, missing-page detection) still runs
 * identically in both modes.
 */
export const assetsPhase = definePhase({
  id: 'assets',
  label: 'Assets & comments',
  dependsOn: ['content'],
  entities: (ctx) => {
    // Neither map exists until its owning phase has actually run (see context.ts's own doc comments on
    // both fields) — an empty map is the correct fallback for a hand-built MigrationContext that never
    // ran `users`/`content` (e.g. a unit test exercising this phase alone): every asset authorId falls
    // back to the operator actor, and every comment's pageId resolves to nothing (reported as
    // 'unknown-page', not a crash) — the same "orphaned FK" treatment an unmapped id already gets
    // elsewhere in this plan.
    const userIdMap = ctx.userIdMap ?? new Map<number, string>()
    const pageIdMap = ctx.pageIdMap ?? new Map<number, string>()

    const assetsModel: AssetsWriteModel = {
      upload: (input) =>
        writeUnlessDryRun(
          ctx.dryRun,
          () => ({ ...placeholderRow(), fileName: input.fileName }),
          () => WIKI.models.assets.upload(input)
        )
    }
    const treeModel: TreeFolderModel = {
      getFolder: (input) =>
        writeUnlessDryRun(ctx.dryRun, placeholderRow, () => WIKI.models.tree.getFolder(input))
    }
    const assetDeps: AssetImportDeps = { assetsModel, treeModel }
    const assetOptions: AssetImportOptions = {
      siteId: ctx.siteId,
      // -> Read fresh off WIKI.sites (not a ctx.primaryLocale value snapshotted before any phase ran)
      //    — see context.ts's resolvePrimaryLocale() doc comment (whole-branch review Critical #1).
      //    Resolved here, at entities()-construction time, rather than deferred into treeModel's own
      //    dry-run-gated closure like content.ts's navigationModel does: resolvePrimaryLocale() already
      //    internalizes the same "stay WIKI-free under dryRun" gate content.ts's dependencies apply by
      //    hand, and this phase's own entities(ctx) is only ever called once the `settings`/`content`
      //    phases it transitively depends on have already finished (MIGRATION_PHASES' sequential run
      //    order — see resolvePrimaryLocale()'s own doc comment).
      locale: resolvePrimaryLocale(ctx),
      userIdMap,
      fallbackActorId: ctx.operatorActorId
    }

    const commentsModel: CommentsWriteModel = {
      create: (input) =>
        writeUnlessDryRun(ctx.dryRun, placeholderRow, () => WIKI.models.comments.create(input))
    }
    const commentDeps: CommentImportDeps = { commentsModel }
    const commentOptions: CommentImportOptions = {
      siteId: ctx.siteId,
      pageIdMap,
      userIdMap
    }

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
          const outcome = await importComment(source, commentDeps, commentOptions)
          if (outcome.result === 'failure') {
            const failure: CommentImportFailure = outcome.failure
            ctx.log?.(`comment ${failure.oldId}: ${failure.reason} — ${failure.message}`)
          }
          await routeOutcome(recorder, identifier, toRecordOutcome(outcome))
        }
      }
    }
  }
})
