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
 * Maps one page's `PageImportOutcome` (`page-import.ts`) onto the three buckets `./route.ts` routes —
 * see that module's own doc comment for why the write already happened by the time this runs.
 *
 * `'existing-entry-collision'` is the one failure reason that means "already exists at the
 * destination", so it goes to the skip bucket. Every other reason (`empty-path`, `invalid-segment`,
 * `sibling-collision`, `create-error`) is a genuine problem preventing the write, not an idempotency
 * skip.
 *
 * `warnings` is `pageImporter.succeeded`'s just-pushed entry (a page-history-backfill failure, per
 * `page-import.ts`'s own `importOne()`), which `PageImportOutcome`'s `'created'` variant has no field
 * for — one logged line each, so a long list of backfill failures doesn't collapse into one unreadable
 * line.
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
 * Phase 3 (Feature 416: content importer). Depends on `users`: every page/history row carries an
 * `authorId`/`creatorId` that must resolve to an already-imported destination user
 * (`ctx.userIdMap`, populated by the `users` phase as a live reference — see `context.ts`).
 *
 * This phase wires together `content-staging.ts`'s `buildContentStagingIndex()`/
 * `extractContentStaging()`, `importers/page-import.ts`'s `createPageImporter()`,
 * `importers/page-history-import.ts`'s `backfillPageHistoryForPage()`, and
 * `importers/navigation-import.ts`'s `importNavigation()`/`extractNavigation()`.
 *
 * ## Two entities, strictly sequential
 *
 * `pages` streams real `StagedPage`s (not raw connector rows) via an async generator that `await`s
 * `buildContentStagingIndex()`'s pre-pass before its first `yield` — the await only actually runs once
 * iteration begins, which is what lets this satisfy `entities(ctx) => Record<string, PhaseEntity>`'s
 * synchronous-return contract while still doing async setup. `navigation` is a small second entity: a
 * one-record sentinel whose `classify` imports 2.x's navigation as the site-wide menu exactly once.
 * `define-phase.ts#readEntity()` drains each entity's source fully before the next one starts
 * (the same ordering `phases/users.ts` relies on) — load-
 * bearing here, since `navigation`'s classify reads `pageImporter.pageIdMap` and
 * `stagingContext.stagedPageRefs`, both of which are only complete once every page has actually been
 * processed by the `pages` entity's own classify (not merely read off the source — see "Dry run" below
 * for why classify, not the source read, is what does the real work).
 *
 * `pageHistory` and `tags` are not given entities of their own: both
 * are embedded in `StagedPage` itself (`content-staging.ts`'s merge-join for history, its
 * denormalized-tags-on-page-rows design for tags — see that module's own doc comment), so there is no
 * separate raw `connector.pageHistory()`/`connector.tags()` read left at the phase level to report a
 * count for. Their real per-run outcomes live inside `pageImporter`'s accumulated state (each
 * `PageImportSuccess.warnings`, which includes a history-backfill failure) rather than in
 * `PhaseReport`/`PhaseResult.counts`, matching `report.ts`'s own documented shape: `wouldSkipExisting`
 * is nonzero "once a phase's classify checks... currently the users, content (pages only) and assets
 * phases" — pages only, deliberately.
 *
 * ## Dry run
 *
 * Unlike `importers/users-groups.ts` (where `ctx.dryRun` picks between `createDrizzleWriter()` and
 * `createDryRunWriter()` up front), the three content importers have no such built-in split — every
 * one of their injected dependencies is an unconditional write. The dry-run split therefore happens
 * here instead, inside each dependency's own closure via `dry-run.ts`'s `writeUnlessDryRun()` (never
 * at `entities()`-construction time, so a `dryRun: true` run never touches the ambient `WIKI` global
 * at all — see `existingEntry`/`createPage`/`insertVersions`/`ensureSiteNav`/`setNavItems` below).
 * `pageImporter.importOne()` and `importNavigation()` are always called directly, never wrapped as
 * `recorder.create()`'s own `write` callback — see `./route.ts` for why — so the real classification
 * logic (collision checks, editor mapping, navigation item mapping/dropping) runs identically in both
 * modes; only the destination-touching half of each dependency is swapped for a no-op or a
 * placeholder id.
 *
 * `existingEntry` is the one exception worth calling out: in a real CLI run, `WIKI`/the destination db
 * are always live even under `--dry-run` (only the *write* is skipped), so checking the real tree for a
 * collision is both possible and correct there. But `phases/users.ts`'s own dry-run precedent never
 * reads the destination at all (`createDryRunWriter()`'s methods touch nothing), and this phase's own
 * pure unit tests (`phases.test.ts`) have no live `WIKI`/db to read — so `existingEntry` reports "not
 * found" unconditionally under `dryRun`, same as every other dependency here, keeping a dry run fully
 * I/O-free rather than a live read plus a stubbed write.
 *
 * ## Navigation targets are sanitized before the real write (review fix)
 *
 * `navigation-import.ts`'s `mapNavigationItem()` carries an `'external'`/`'externalblank'` item's
 * `target` through verbatim, unvalidated — a schemeless target, or a `javascript:`/`ftp:` URL from an
 * old 2.x menu, passes straight through. But the real `models/navigation.ts#setNavItems()` calls
 * `assertValidNavItems()`, which *throws* `CustomError('navigationInvalidTarget')` for exactly that
 * shape. Since `importNavigation()`'s own write happens inside this phase's `navigation` entity —
 * which runs strictly after every page has already been created — an uncaught throw there would have
 * reached `define-phase.ts#readEntity()`'s catch, which only special-cases `NotYetImplementedError`;
 * anything else propagates out of `run()` as `status: 'error'` with `emptyPhaseReport()`, discarding
 * the whole phase's report for every page already successfully imported in the same run. The
 * `navigationModel.setNavItems` below therefore runs the resolved items through
 * `models/navigation.ts#sanitizeNavItemTargets()` — the same function `copyNav()` already uses for the
 * identical "items that predate this validation" case — before ever calling `setNavItems()`, and logs
 * (via `ctx.log`) which items had their target blanked, since `sanitizeNavItemTargets()` itself reports
 * nothing back beyond the sanitized array.
 *
 * ## Orphaned pageHistory is backfilled too (review fix)
 *
 * `stagingContext.orphanedHistory` (2.x `pageHistory` rows whose `pageId` names no current page — a
 * deleted 2.x page, per `content-staging.ts`'s own doc) is only complete once `pages` has fully
 * drained, same as `stagedPageRefs`. It has no single page to backfill against inline the way a live
 * page's own history does (`pagesDeps.backfillHistory`, called per-page from inside
 * `pageImporter.importOne()`), so it is drained here instead, in the `navigation` entity's classify —
 * the only other hook that is guaranteed to run after `pages` has fully drained. Delegates to
 * `page-history-import.ts#backfillOrphanedPageHistory()` to get its
 * synthesized-shared-`pageId`-per-group behavior for free, rather than reimplementing the grouping
 * here.
 */
export const contentPhase = definePhase({
  id: 'content',
  label: 'Pages, page history & tags',
  dependsOn: ['users'],
  entities: (ctx) => {
    // `ctx.userIdMap` does not exist until the `users` phase has actually run (see context.ts's own
    // doc comment) — an empty map is the correct fallback for a hand-built MigrationContext that never
    // ran it (e.g. a unit test exercising this phase alone): every authorId/creatorId then falls back
    // to ctx.operatorActorId via resolveActorId(), the same "orphaned FK" path a genuinely unmapped
    // source id already takes.
    const userIdMap = ctx.userIdMap ?? new Map<number, string>()
    const stagingOptions: ContentStagingOptions = {
      userIdMap,
      fallbackActorId: ctx.operatorActorId
    }
    const stagingContext = createContentStagingContext()

    // -> Shared between the per-page backfill below (pagesDeps.backfillHistory) and the orphaned-
    //    history batch backfill (the navigation entity's classify) — same "compute for real, write
    //    only when live" split every other dependency in this phase uses.
    async function insertHistoryVersions(rows: PageHistoryInsertRow[]): Promise<void> {
      if (ctx.dryRun) return
      await WIKI.db.insert(pageHistoryTable).values(rows)
    }

    const pagesModel: PagesWriteModel = {
      createPage: (siteId, input, actor) =>
        writeUnlessDryRun(
          ctx.dryRun,
          // -> Only `.id` is ever read off the result (page-import.ts's importOne()), so a minimal
          //    object cast through `unknown` is safe here — narrow, deliberate, matching CLAUDE.md's
          //    cast convention.
          () => placeholderRow() as unknown as Page,
          () => WIKI.models.pages.createPage(siteId, input, actor)
        )
    }

    const pagesDeps: ImportPagesDeps = {
      pagesModel,
      existingEntry: async (siteId, locale, parentPath, fileName) => {
        if (ctx.dryRun) {
          // -> See the module doc comment's "Dry run" section for why this does not read the real
          //    destination even though one is normally live under a CLI dry run.
          return false
        }
        const entry = await WIKI.models.tree.getEntryAt({ siteId, locale, parentPath, fileName })
        return entry !== null
      },
      backfillHistory: (staged, newPageId) =>
        backfillPageHistoryForPage(staged, newPageId, ctx.siteId, {
          insertVersions: insertHistoryVersions
        })
    }

    const pageImporter = createPageImporter(pagesDeps, {
      siteId: ctx.siteId,
      // -> The migration operator is trusted with full content authority over what it imports —
      //    withholding write:scripts/write:styles would silently strip <script>/<style> blocks from
      //    every imported page that had them, a real regression for a migration, not a safety net a
      //    2.x source's own original author's (unknown, possibly nonexistent on this install)
      //    permissions could ever meaningfully stand in for. See page-import.ts's own doc comment,
      //    "The synthetic per-page actor".
      actorPermissions: ['write:scripts', 'write:styles'],
      // -> Already resolved to a concrete 'passthrough'/'queue' by `tasks/migrate.ts` before this
      //    `MigrationContext` was built — see `context.ts`'s own doc on `renderMode` for why this
      //    phase never resolves Puppeteer availability itself. Falls back to 'passthrough' (matching
      //    `createPageImporter()`'s own default) for a hand-built `MigrationContext` that omits it.
      renderBootstrap: ctx.renderMode ?? 'passthrough'
    })
    // Handed to the assets/comments phase (dependsOn: ['content']) — see context.ts's own
    // doc on pageIdMap for why this is a live Map reference, not a snapshot.
    ctx.pageIdMap = pageImporter.pageIdMap

    const navigationModel: NavigationWriteModel = {
      ensureSiteNav: (siteId, locale) =>
        writeUnlessDryRun(
          ctx.dryRun,
          () => placeholderRow().id,
          () => WIKI.models.navigation.ensureSiteNav(siteId, locale)
        ),
      async setNavItems(siteId, navId, items) {
        // -> See the module doc comment's "Navigation targets are sanitized" section: setNavItems()
        //    throws for an item whose target isn't a rooted path or a complete http(s)/mailto/tel
        //    address, which a 2.x source's 'external'/'externalblank' item is never validated
        //    against on the way in. Sanitizing here (2.x navigation is flat — see
        //    navigation-import.ts's own doc comment — so there are never any `children` to recurse
        //    into) is what keeps a single bad legacy target from throwing this deep into the phase,
        //    after every page has already been written. Computed unconditionally (unlike the actual
        //    write below) since it is pure, no-I/O classification, not a destination read/write — a
        //    dry run should see which targets would be blanked too, the same "compute for real
        //    either way" rule pagesModel.createPage follows.
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
        await WIKI.models.navigation.setNavItems(siteId, navId, sanitized)
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
        // -> A one-record sentinel: readEntity() drains `pages` fully before this entity even starts
        //    (object-key order — see the module doc comment), so pageImporter.pageIdMap and
        //    stagingContext.stagedPageRefs are already complete by the time this classify runs.
        source: async function* () {
          yield { key: 'site-navigation' }
        },
        classify: async (_record, recorder) => {
          // -> See the module doc comment's "Orphaned pageHistory is backfilled too" section. Every
          //    live page's own history was already backfilled per-page, inline, as `pages` streamed.
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
          // -> importNavigation()'s own `dropped`/`warnings` (whole-branch review Important #3) had
          //    nowhere to go before this — `navigation` is a one-record sentinel (see below), so there
          //    is no per-item `WriteRecorder` call to attach either to. Logged here instead, the same
          //    "one line per entry" convention this phase already uses for the sanitize-before-write
          //    step's own blanked-target warning (`navigationModel.setNavItems` above) and for the
          //    orphaned-history backfill's own warnings/failures just above.
          for (const warning of navigationResult.warnings) {
            ctx.log?.(`navigation: ${warning}`)
          }
          for (const dropped of navigationResult.dropped) {
            ctx.log?.(
              `navigation item "${dropped.title}" (target "${dropped.target}"): dropped — ${dropped.reason}`
            )
          }
          // -> importNavigation() always writes something (an empty items array is a valid,
          //    successful outcome) and never throws for a dropped item — those are folded into its
          //    own `dropped`/`warnings` instead — so 'created' is always the right outcome for this
          //    single sentinel record. The real write already happened above (or was no-op'd by
          //    navigationModel under dryRun).
          await recorder.create('site-navigation')
        }
      }
    }
  }
})
