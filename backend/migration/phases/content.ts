import { pageHistory as pageHistoryTable } from '../../db/schema.ts'
import { sanitizeNavItemTargets } from '../../models/navigation.ts'
import {
  buildContentStagingIndex,
  createContentStagingContext,
  extractContentStaging,
  extractNavigation
} from '../content-staging.ts'
import {
  backfillOrphanedPageHistory,
  backfillPageHistoryForPage
} from '../importers/page-history-import.ts'
import { createPageImporter } from '../importers/page-import.ts'
import { importNavigation } from '../importers/navigation-import.ts'
import { resolvePrimaryLocale } from '../context.ts'
import { definePhase } from './define-phase.ts'
import { placeholderRow, writeUnlessDryRun } from './dry-run.ts'
import { routeOutcome } from './route.ts'
import type { Page } from '../../models/pages.ts'
import type { ContentStagingOptions, StagedPage } from '../content-staging.ts'
import type { PageHistoryInsertRow } from '../importers/page-history-import.ts'
import type {
  ImportPagesDeps,
  PageImportOutcome,
  PagesWriteModel
} from '../importers/page-import.ts'
import type { NavigationImportDeps, NavigationWriteModel } from '../importers/navigation-import.ts'
import type { RecordOutcome } from './route.ts'

/**
 * `'existing-entry-collision'` is the one failure reason meaning "already exists at the destination",
 * so it is an idempotency skip; every other reason is a genuine problem preventing the write.
 */
function toRecordOutcome(
  identifier: string,
  outcome: PageImportOutcome,
  warnings: string[]
): RecordOutcome {
  if (outcome.status === 'created') {
    return { outcome: 'created', notes: warnings.map((w) => `page ${identifier}: ${w}`) }
  }
  if (outcome.reason === 'existing-entry-collision') {
    return { outcome: 'skipped' }
  }
  return { outcome: 'conflicted', detail: outcome.message }
}

/**
 * Depends on `users`: every page and history row carries an `authorId`/`creatorId` that must resolve
 * to an already-imported destination user through `ctx.userIdMap`.
 *
 * `pages` streams `StagedPage`s from an async generator that `await`s `buildContentStagingIndex()`'s
 * pre-pass before its first `yield` — the await only runs once iteration begins, which is what lets
 * this do async setup while still satisfying `entities()`'s synchronous-return contract.
 * `navigation` is a one-record sentinel that must run second: `readEntity()` drains each entity's
 * source fully before the next starts (object-key order), and navigation's classify needs
 * `pageImporter.pageIdMap` and `stagingContext.stagedPageRefs`, complete only once every page has
 * been through the `pages` classify.
 *
 * Page history and tags get no entity of their own — both are embedded in `StagedPage` — so neither
 * has a raw source read left to report a count for.
 *
 * Dry run: the content importers have no built-in dry-run writer of their own, so the split happens
 * inside each dependency's closure via `writeUnlessDryRun()` rather than at `entities()`-construction
 * time, keeping a `dryRun: true` run off the ambient `CARDINAL` global entirely. Classification
 * (collision checks, editor mapping, navigation item mapping/dropping) runs identically either way;
 * only the destination-touching half of each dependency becomes a no-op or a placeholder id.
 */
export const contentPhase = definePhase({
  id: 'content',
  label: 'Pages, page history & tags',
  dependsOn: ['users'],
  entities: (ctx) => {
    // An empty map is the correct fallback for a hand-built MigrationContext that never ran the
    // `users` phase: every authorId/creatorId then falls back to ctx.operatorActorId via
    // resolveActorId(), the same "orphaned FK" path a genuinely unmapped source id already takes.
    const userIdMap = ctx.userIdMap ?? new Map<number, string>()
    const stagingOptions: ContentStagingOptions = {
      userIdMap,
      fallbackActorId: ctx.operatorActorId
    }
    const stagingContext = createContentStagingContext()

    async function insertHistoryVersions(rows: PageHistoryInsertRow[]): Promise<void> {
      if (ctx.dryRun) return
      await CARDINAL.db.insert(pageHistoryTable).values(rows)
    }

    const pagesModel: PagesWriteModel = {
      createPage: (siteId, input, actor) =>
        writeUnlessDryRun(
          ctx.dryRun,
          // -> Only `.id` is ever read off the result, so the narrow cast through `unknown` is safe.
          () => placeholderRow() as unknown as Page,
          () => CARDINAL.models.pages.createPage(siteId, input, actor)
        )
    }

    const pagesDeps: ImportPagesDeps = {
      pagesModel,
      existingEntry: async (siteId, locale, parentPath, fileName) => {
        if (ctx.dryRun) {
          // -> A dry run stays entirely I/O-free, so no collision check either, even though the
          //    destination db is normally live under the CLI's --dry-run.
          return false
        }
        const entry = await CARDINAL.models.tree.getEntryAt({
          siteId,
          locale,
          parentPath,
          fileName
        })
        return entry !== null
      },
      backfillHistory: (staged, newPageId) =>
        backfillPageHistoryForPage(staged, newPageId, ctx.siteId, {
          insertVersions: insertHistoryVersions
        })
    }

    const pageImporter = createPageImporter(pagesDeps, {
      siteId: ctx.siteId,
      // -> The migration operator is trusted with full content authority over what it imports:
      //    withholding these would silently strip <script>/<style> blocks from every imported page
      //    that had them, which no 2.x author's (unknown, possibly nonexistent) permissions could
      //    meaningfully stand in for.
      forcedPagePermissions: ['write:scripts', 'write:styles'],
      // -> Resolved to a concrete 'passthrough'/'queue' by `tasks/migrate.ts` before the context is
      //    built, so this phase never probes Puppeteer availability itself; the fallback covers a
      //    hand-built `MigrationContext` that omits it.
      renderBootstrap: ctx.renderMode ?? 'passthrough'
    })
    // Read by the assets/comments phase as a live reference, not a snapshot.
    ctx.pageIdMap = pageImporter.pageIdMap

    const navigationModel: NavigationWriteModel = {
      ensureSiteNav: (siteId, locale) =>
        writeUnlessDryRun(
          ctx.dryRun,
          () => placeholderRow().id,
          () => CARDINAL.models.navigation.ensureSiteNav(siteId, locale)
        ),
      async setNavItems(siteId, navId, items) {
        // -> setNavItems() throws for a target that isn't a rooted path or a complete
        //    http(s)/mailto/tel address, which a 2.x 'external'/'externalblank' item is never
        //    validated against on the way in. A throw this late propagates out of run() and
        //    discards the phase's whole report, including every page already imported. Sanitizing
        //    runs even under dryRun — it is pure classification, and a dry run should report the
        //    blanked targets too. (2.x navigation is flat, so there are no `children` to recurse.)
        const sanitized = sanitizeNavItemTargets(items)
        for (const [index, item] of items.entries()) {
          const original = item.target
          const cleaned = sanitized[index]!.target
          if (original !== cleaned) {
            ctx.log?.(
              `navigation item "${item.label ?? item.id}": target "${original}" is neither a rooted ` +
                'path nor a complete http(s)/mailto/tel address (a 2.x menu item that predates this ' +
                'validation) — blanked rather than written, to avoid failing the whole content phase.'
            )
          }
        }
        if (ctx.dryRun) return
        await CARDINAL.models.navigation.setNavItems(siteId, navId, sanitized)
      }
    }
    const navigationDeps: NavigationImportDeps = { navigationModel }

    async function* pagesSource(): AsyncGenerator<StagedPage> {
      const index = await buildContentStagingIndex(ctx.source)
      yield* extractContentStaging(ctx.source, stagingOptions, index, stagingContext)
    }

    return {
      pages: {
        source: pagesSource,
        classify: async (record, recorder) => {
          const staged = record as StagedPage
          const outcome = await pageImporter.importOne(staged)
          const warnings =
            outcome.status === 'created' ? (pageImporter.succeeded.at(-1)?.warnings ?? []) : []
          const identifier = String(staged.oldId)
          await routeOutcome(
            recorder,
            identifier,
            toRecordOutcome(identifier, outcome, warnings),
            ctx.log
          )
        }
      },
      navigation: {
        source: async function* () {
          yield { key: 'site-navigation' }
        },
        classify: async (_record, recorder) => {
          // -> Orphaned history (2.x rows whose pageId names no current page) has no live page to
          //    backfill against inline the way a page's own history does, and is complete only once
          //    `pages` has drained — so it is drained here, the only hook guaranteed to run after.
          const orphanedResult = await backfillOrphanedPageHistory(
            stagingContext.orphanedHistory,
            ctx.siteId,
            { insertVersions: insertHistoryVersions }
          )
          for (const warning of orphanedResult.warnings) {
            ctx.log?.(warning)
          }
          for (const failure of orphanedResult.failed) {
            ctx.log?.(
              `orphaned pageHistory backfill failed for source page ${failure.oldId}: ${failure.message}`
            )
          }

          const staged = await extractNavigation(ctx.source)
          const navigationResult = await importNavigation(
            staged,
            stagingContext.stagedPageRefs,
            pageImporter.pageIdMap,
            navigationDeps,
            { siteId: ctx.siteId, locale: resolvePrimaryLocale(ctx) }
          )
          // -> A one-record sentinel has no per-item `WriteRecorder` call to attach these to, so
          //    they are logged one line each instead.
          for (const warning of navigationResult.warnings) {
            ctx.log?.(`navigation: ${warning}`)
          }
          for (const dropped of navigationResult.dropped) {
            ctx.log?.(
              `navigation item "${dropped.title}" (target "${dropped.target}"): dropped — ${dropped.reason}`
            )
          }
          // -> importNavigation() always writes something (an empty items array is a valid outcome)
          //    and never throws for a dropped item, so 'created' is always right for this sentinel.
          await recorder.create('site-navigation')
        }
      }
    }
  }
})
