import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import {
  assets as assetsTable,
  navigation as navigationTable,
  tree as treeTable
} from '../../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../../test/db.ts'
import { assetsPhase } from './assets.ts'
import { contentPhase } from './content.ts'
import { settingsPhase } from './settings.ts'
import type { TestFixtures } from '../../test/db.ts'
import type { SourceAssetFile, SourceConnector, SourceRecord } from '../connector.ts'
import type { MigrationContext } from '../context.ts'
import { iterate as iter, stubSourceConnector } from '../../test/migrationFixtures.ts'

/**
 * A `SourceConnector` for a 2.x install whose primary locale is French (`lang.code: 'fr'`), not the
 * destination's pre-migration default (`'en'`) — matching this suite's own purpose, see the module
 * doc comment below. `navigation()`'s modern per-locale format carries a distinct item per locale
 * (`'English Home'` under `'en'`, `'Accueil'` under `'fr'`), so which one lands as the site's real
 * menu directly proves which locale `contentPhase` actually resolved.
 */
function fakeSourceConnector(): SourceConnector {
  return stubSourceConnector({
    settings: () =>
      iter<SourceRecord>([{ entity: 'settings', key: 'lang', value: { code: 'fr' } }]),
    pages: () =>
      iter<SourceRecord>([
        {
          id: 1,
          path: 'accueil',
          localeCode: 'fr',
          title: 'Accueil',
          hash: 'hash-1',
          description: null,
          content: '# Accueil',
          render: '<h1>Accueil</h1>',
          toc: null,
          contentType: 'markdown',
          isPrivate: false,
          privateNS: null,
          isPublished: true,
          publishStartDate: null,
          publishEndDate: null,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          extra: {},
          editorKey: 'markdown',
          tags: [],
          authorId: null,
          creatorId: null
        }
      ]),
    pageHistory: () => iter<SourceRecord>([]),
    navigation: () =>
      iter<SourceRecord>([
        {
          key: 'site',
          config: [
            {
              locale: 'en',
              items: [
                {
                  id: 'nav-en',
                  kind: 'link',
                  label: 'English Home',
                  targetType: 'home',
                  target: ''
                }
              ]
            },
            {
              locale: 'fr',
              items: [
                { id: 'nav-fr', kind: 'link', label: 'Accueil', targetType: 'home', target: '' }
              ]
            }
          ]
        }
      ]),
    comments: () => iter<SourceRecord>([]),
    assets: () =>
      iter<SourceAssetFile>([
        {
          relativePath: 'logo.png',
          filename: 'logo.png',
          stream: Readable.from([Buffer.from('fake-image-bytes')]),
          authorId: undefined,
          mimeType: 'image/png'
        }
      ])
  })
}

/**
 * Whole-branch review Critical #1: `ctx.primaryLocale` used to be captured in `tasks/migrate.ts`
 * BEFORE any phase ran — always `'en'` on a fresh destination — and never updated even after the
 * `settings` phase (which runs first) changed the destination site's real primary locale via
 * `updateSite()`. `phases/content.ts`'s navigation write and `phases/assets.ts`'s asset/folder writes
 * both keyed off that stale value, so a non-English 2.x source's imported nav/assets always landed
 * under `'en'` regardless of what the source's own `lang.code` said.
 *
 * This suite runs the real `settings` phase first (flipping the destination's primary locale from
 * `'en'` to `'fr'`), then the real `content`/`assets` phases against the SAME `MigrationContext` — no
 * process restart, no re-bootstrap — and asserts the nav row and the uploaded asset both land under
 * `'fr'`, the locale `settings` just set, not the destination's pre-migration `'en'` default.
 */
describe(
  'locale propagation: settings phase changes the primary locale, content/assets phases pick it up (Critical #1 fix)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
    })

    after(async () => {
      await teardownTestDb()
    })

    test('nav and asset rows land under the locale the settings phase just set, not the destination default', async () => {
      const ctx: MigrationContext = {
        db: fixtures.db,
        source: fakeSourceConnector(),
        siteId: fixtures.siteId,
        dryRun: false,
        localStrategyId: 'unused-local-strategy',
        systemGroupIds: { admin: 'unused-admin-group', guest: 'unused-guest-group' },
        operatorActorId: fixtures.userId,
        // -> Stands in for a completed users-phase run; neither the page nor the asset in this
        //    fixture has a resolvable authorId, so this is never actually consulted.
        userIdMap: new Map()
      }

      // -> Sanity check before touching anything: the fixture site starts at the destination's
      //    ordinary pre-migration default.
      assert.equal(WIKI.sites[fixtures.siteId]!.config.locales.primary, 'en')

      const settingsResult = await settingsPhase.run(ctx)
      assert.equal(settingsResult.status, 'ok')
      assert.equal(
        WIKI.sites[fixtures.siteId]!.config.locales.primary,
        'fr',
        "the settings phase actually changed the destination site's real primary locale"
      )

      const contentResult = await contentPhase.run(ctx)
      assert.equal(contentResult.status, 'ok')

      const assetsResult = await assetsPhase.run(ctx)
      assert.equal(assetsResult.status, 'ok')

      // -> The navigation row was written under 'fr' (resolvePrimaryLocale() re-read the destination's
      //    now-current primary locale), never under the stale 'en' default -- and its item is the
      //    'fr'-tree's own item, proving extractLocaleItems() picked the right per-locale tree out of
      //    2.x's config, not just that some row happened to land at locale 'fr'.
      const [navRow] = await fixtures.db
        .select()
        .from(navigationTable)
        .where(and(eq(navigationTable.siteId, fixtures.siteId), eq(navigationTable.locale, 'fr')))
      assert.ok(navRow, 'the site navigation row was written under the fr locale')
      assert.deepEqual(navRow!.items, [
        { id: 'nav-fr', type: 'link', label: 'Accueil', target: '/' }
      ])

      const enNavRows = await fixtures.db
        .select()
        .from(navigationTable)
        .where(and(eq(navigationTable.siteId, fixtures.siteId), eq(navigationTable.locale, 'en')))
      assert.equal(enNavRows.length, 0, 'no navigation row was written under the stale en default')

      // -> The uploaded asset's tree row was written under 'fr' too.
      const [treeEntry] = await fixtures.db
        .select()
        .from(treeTable)
        .where(
          and(
            eq(treeTable.siteId, fixtures.siteId),
            eq(treeTable.fileName, 'logo.png'),
            eq(treeTable.type, 'asset')
          )
        )
      assert.ok(treeEntry, 'the uploaded asset has a tree entry')
      assert.equal(treeEntry!.locale, 'fr', 'the asset landed under fr, not the stale en default')

      const [assetRow] = await fixtures.db
        .select()
        .from(assetsTable)
        .where(eq(assetsTable.id, treeEntry!.id))
      assert.ok(assetRow, 'the assets row exists alongside the tree entry')
    })
  }
)
