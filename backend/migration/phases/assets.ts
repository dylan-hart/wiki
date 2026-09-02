import { importAsset } from '../importers/asset-import.ts'
import { importComment } from '../importers/comment-import.ts'
import { resolvePrimaryLocale } from '../context.ts'
import { definePhase } from './define-phase.ts'
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
import type { WriteRecorder } from '../recorder.ts'

/**
 * Routes an `importAsset()`/`importComment()` outcome onto the matching `WriteRecorder` call, mirroring
 * `phases/content.ts`'s `routePageOutcome()` and `phases/users.ts`'s `routeOutcome()` — the same class
 * of bug those two review rounds fixed applies here too, and this task's own brief was written with
 * that lesson in mind, but its illustrative sketch still wrapped the import call *inside*
 * `recorder.create()`'s own `write` callback and let a failure outcome throw out of it. Checked against
 * the real `recorder.ts` (not assumed from the sketch): `DryRunAwareRecorder.create()` does
 * `await write()` with no `try`/`catch` of its own, so a thrown error there propagates all the way out
 * of `classify()` to `define-phase.ts#readEntity()`'s `for await` loop, which only special-cases
 * `NotYetImplementedError` — any other error rethrows further, past `readEntity()`, and is caught by
 * `definePhase()`'s own `run()` try/catch as `status: 'error'` with an **emptied** report, discarding
 * every asset/comment already successfully imported in the same run. That is exactly the "one failed
 * page-history parse takes down the whole content phase" class of bug those two prior review rounds
 * fixed for `pages`/`users`/`groups` — this phase gets it right from the start by calling
 * `importAsset()`/`importComment()` directly (not as `create()`'s `write` argument) and routing the
 * result afterward: success -> `recorder.create(identifier, async () => {})` (a deliberate no-op, since
 * the real write already happened above — still a real function so
 * `define-phase.ts#trackWriteCapability()` sees this phase genuinely has a write path), failure ->
 * `recorder.conflict(identifier, detail)` (a write that was attempted and did not succeed — the same
 * bucket `routePageOutcome()` uses for every content-import failure reason that isn't "already
 * exists").
 */
async function routeImportOutcome(
  recorder: WriteRecorder,
  identifier: string,
  outcome: { result: 'success' } | { result: 'failure'; failure: { message: string } }
): Promise<void> {
  if (outcome.result === 'success') {
    await recorder.create(identifier, async () => {})
    return
  }
  recorder.conflict(identifier, outcome.failure.message)
}

/**
 * Phase 4 (Feature 418: assets/comments importer). Depends on `content`: an asset's folder placement
 * and a comment's `pageId` both resolve against pages the `content` phase (Task 13) must have already
 * created — `ctx.pageIdMap`, a live reference populated as that phase's `pages` entity runs (see
 * `context.ts`'s own doc comment on the field).
 *
 * Task 16 wires this phase to the real write engines Task 16 itself builds: `importers/asset-import.ts`
 * (`importAsset()`, driving `models/tree.ts#getFolder({ createIfMissing: true })` then
 * `models/assets.ts#upload()`) and `importers/comment-import.ts` (`importComment()`, driving
 * `models/comments.ts#create()`). Comments no longer have a `staticUnmappable` entry — 3.0's own
 * comments table has had a real import path since this task, so `COMMENTS_UNMAPPABLE` (the earlier,
 * structural "the SourceConnector interface has no `comments()` generator yet" note) was deleted along
 * with its only caller.
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
      async upload(input) {
        if (ctx.dryRun) {
          // -> Mirrors phases/content.ts's pagesModel.createPage() dry-run branch: mint a placeholder
          //    id instead of really writing, so importAsset()'s own classification logic (folder
          //    resolution, actor fallback) still runs identically in both modes.
          return { id: crypto.randomUUID(), fileName: input.fileName }
        }
        return WIKI.models.assets.upload(input)
      }
    }
    const treeModel: TreeFolderModel = {
      async getFolder(input) {
        if (ctx.dryRun) {
          return { id: crypto.randomUUID() }
        }
        return WIKI.models.tree.getFolder(input)
      }
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
      async create(input) {
        if (ctx.dryRun) {
          return { id: crypto.randomUUID() }
        }
        return WIKI.models.comments.create(input)
      }
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
          await routeImportOutcome(recorder, identifier, outcome)
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
          await routeImportOutcome(recorder, identifier, outcome)
        }
      }
    }
  }
})
