import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedTreeEntry,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import {
  navigation as navigationTable,
  sites as sitesTable,
  tree as treeTable
} from '../db/schema.ts'
import { NAVIGATION_MODES, type NavigationItem, type NavigationMode } from './navigation.ts'

/** The mode/cascade combination `updateNavigation()` should produce for a top-level entry. */
function expectedTransition(
  mode: NavigationMode,
  wasCascading: boolean,
  ancestorId: string,
  ownNavId: string
): { navId: string | null; cascadeTo: string | null | undefined } {
  switch (mode) {
    case 'inherit':
      return { navId: ancestorId, cascadeTo: wasCascading ? ancestorId : undefined }
    case 'override':
      return { navId: ownNavId, cascadeTo: ownNavId }
    case 'overrideExact':
      return { navId: ownNavId, cascadeTo: wasCascading ? ancestorId : undefined }
    case 'hide':
      return { navId: null, cascadeTo: null }
    case 'hideExact':
      return { navId: null, cascadeTo: wasCascading ? ancestorId : undefined }
  }
}

/**
 * `models/navigation.ts` is almost entirely SQL — a menu lookup, an ancestor-cascade query written in
 * raw `ltree` operators, and a tree-entry update coordinated with it — so this runs the real methods
 * against a migrated, per-run-fresh database (see `test/db.ts`) rather than mocking the query builder.
 *
 * Doubles as the proof that the shared DB fixture is sufficient for `models/navigation.ts` to run:
 * standing that up is this task's actual deliverable (Feature 361, task 465), and `seedTreeEntry()` is
 * the fixture helper it adds for every later task in this Feature to build on.
 */
describe('navigation (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  const items: NavigationItem[] = [
    { id: 'a', type: 'link', label: 'Everyone', target: '/everyone' },
    { id: 'b', type: 'link', label: 'Admins only', target: '/admins', visibilityGroups: ['admins'] }
  ]

  test('ensureSiteNav creates an empty menu once, idempotently', async () => {
    await navigationModel.ensureSiteNav(fixtures.siteId)
    assert.deepEqual(await navigationModel.getNav(fixtures.siteId, { unfiltered: true }), [])

    // -> A page's menu is saved before ensureSiteNav would run again for the same site (e.g. a second
    //    edit); onConflictDoNothing is what keeps that second call from wiping it back to empty.
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: (await seedTreeEntry(fixtures.db, { siteId: fixtures.siteId, path: 'home' })).id,
      mode: 'inherit',
      items
    })
    await navigationModel.ensureSiteNav(fixtures.siteId)
    assert.deepEqual(await navigationModel.getNav(fixtures.siteId, { unfiltered: true }), items)
  })

  test('getNav filters items and their children by visibility group', async () => {
    const page = await seedTreeEntry(fixtures.db, {
      siteId: fixtures.siteId,
      path: 'filtered-page'
    })
    const { navigationId } = await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override',
      items
    })
    assert.equal(navigationId, page.id)

    const asGuest = await navigationModel.getNav(navigationId!, { userGroups: [] })
    assert.deepEqual(
      asGuest.map((i) => i.id),
      ['a']
    )

    const asAdmin = await navigationModel.getNav(navigationId!, { userGroups: ['admins'] })
    assert.deepEqual(
      asAdmin.map((i) => i.id),
      ['a', 'b']
    )
  })

  test('updateNavigation on a folder with mode=override cascades to inheriting descendants', async () => {
    const folder = await seedTreeEntry(fixtures.db, {
      siteId: fixtures.siteId,
      path: 'docs',
      type: 'folder'
    })
    const child = await seedTreeEntry(fixtures.db, { siteId: fixtures.siteId, path: 'docs/child' })

    const { navigationId } = await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: folder.id,
      mode: 'override',
      items
    })

    assert.equal(navigationId, folder.id)
    assert.equal(await navigationModel.inheritedNavId(fixtures.siteId, child.id), folder.id)
  })

  test('updateNavigation rejects a page id that does not exist', async () => {
    await assert.rejects(
      navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: '00000000-0000-0000-0000-000000000000',
        mode: 'inherit'
      }),
      /does not exist/
    )
  })

  /**
   * `ancestorNavId()` (private) is the ltree cascade query at the heart of the model; it is only
   * reachable through its public wrapper `inheritedNavId()`, which just resolves the calling entry's
   * `folderPath` first. These seed a tree by hand (rather than going through `updateNavigation`, which
   * exercises the same query indirectly above) so each case isolates exactly one thing the raw SQL has
   * to get right.
   */
  describe('inheritedNavId / ancestorNavId resolution', () => {
    test('a root-level page (empty folderPath) resolves to the site menu without querying tree', async (t) => {
      const executeSpy = t.mock.method(fixtures.db, 'execute')
      const root = await seedTreeEntry(fixtures.db, { siteId: fixtures.siteId, path: 'root-page' })

      const result = await navigationModel.inheritedNavId(fixtures.siteId, root.id)

      assert.equal(result, fixtures.siteId)
      // -> `ancestorNavId` short-circuits on an empty folderPath before ever building the ltree query;
      //    `getEntry`'s own lookup goes through the query builder, not `db.execute`, so a call here
      //    would only come from the raw-SQL branch this case must not reach.
      assert.equal(executeSpy.mock.callCount(), 0)
    })

    test('a page with no overriding/hiding ancestor anywhere above it falls back to the site menu', async () => {
      const folder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'plain-branch',
        type: 'folder'
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'plain-branch/leaf'
      })
      // -> Sanity: the ancestor really is on the default mode, not incidentally excluded some other way
      assert.equal(folder.navigationMode, 'inherit')

      assert.equal(await navigationModel.inheritedNavId(fixtures.siteId, page.id), fixtures.siteId)
    })

    test("exactly one overriding ancestor: resolves to that ancestor's navigationId", async () => {
      const overrideNavId = randomUUID()
      const folder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'override-branch',
        type: 'folder',
        navigationMode: 'override',
        navigationId: overrideNavId
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'override-branch/leaf'
      })

      assert.equal(await navigationModel.inheritedNavId(fixtures.siteId, page.id), overrideNavId)
      assert.notEqual(overrideNavId, folder.id)
    })

    test("exactly one hiding ancestor: resolves to that ancestor's (null) navigationId, not the site menu", async () => {
      const folder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'hide-branch',
        type: 'folder',
        navigationMode: 'hide',
        navigationId: null
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'hide-branch/leaf'
      })

      const result = await navigationModel.inheritedNavId(fixtures.siteId, page.id)

      // -> Must be exactly null (a hidden sidebar), not coerced to the site id the way "no match at
      //    all" is. `assert.equal` would let `undefined` slip through here just as easily as `null`.
      assert.strictEqual(result, null)
      assert.notEqual(result, fixtures.siteId)
      void folder
    })

    test('two overriding/hiding ancestors at different depths: the nearer one wins', async () => {
      const farNavId = randomUUID()
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'levels',
        type: 'folder',
        navigationMode: 'override',
        navigationId: farNavId
      })
      // -> The nearer ancestor hides rather than overrides, so a wrong answer here can't be mistaken
      //    for "picked some override" — it has to specifically be the deeper row's null, not the
      //    shallower row's navigationId, and ORDER BY nlevel(...) DESC is what makes that true instead
      //    of depending on whichever row postgres happens to scan first.
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'levels/nested',
        type: 'folder',
        navigationMode: 'hide',
        navigationId: null
      })
      const leaf = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'levels/nested/leaf'
      })

      const result = await navigationModel.inheritedNavId(fixtures.siteId, leaf.id)

      assert.strictEqual(result, null)
      assert.notEqual(result, farNavId)
    })

    test('a sibling subtree that overrides does not affect a page under a different branch', async () => {
      const siblingNavId = randomUUID()
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'branch-a',
        type: 'folder',
        navigationMode: 'override',
        navigationId: siblingNavId
      })
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'branch-b',
        type: 'folder'
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'branch-b/leaf'
      })

      const result = await navigationModel.inheritedNavId(fixtures.siteId, page.id)

      assert.equal(result, fixtures.siteId)
      assert.notEqual(result, siblingNavId)
    })
  })

  /**
   * The mode-transition matrix (navigation.ts:220-284): every `NAVIGATION_MODES` value, arrived at
   * from a prior mode that cascaded (`override`) and one that didn't (`inherit`), checking the
   * persisted `navigationMode`/`navigationId` on the entry itself and, via a seeded `inherit` child,
   * whether a cascade `UPDATE` ran at all — not just what `cascadeTo` computes to internally.
   *
   * Every case seeds a fresh top-level folder (`folderPath === ''`), so `ancestorNavId` always
   * resolves to `fixtures.siteId` without depending on the ltree query already covered above, and
   * `ownNavId` is always the folder's own id (never the site-root special case, covered separately
   * below). The child starts on a random sentinel `navigationId` that matches neither candidate, so
   * "cascade did not touch it" and "cascade set it to X" are never ambiguous.
   */
  describe('updateNavigation mode-transition matrix', () => {
    const priorByCategory = { cascading: 'override', noncascading: 'inherit' } as const

    for (const mode of NAVIGATION_MODES) {
      for (const [category, priorMode] of Object.entries(priorByCategory) as [
        keyof typeof priorByCategory,
        NavigationMode
      ][]) {
        test(`${priorMode} (${category} prior) -> ${mode}`, async () => {
          const wasCascading = category === 'cascading'
          const slug = `matrix-${mode}-${category}`
          const folder = await seedTreeEntry(fixtures.db, {
            siteId: fixtures.siteId,
            path: slug,
            type: 'folder',
            navigationMode: priorMode,
            navigationId: priorMode === 'override' ? randomUUID() : null
          })
          const sentinelNavId = randomUUID()
          const child = await seedTreeEntry(fixtures.db, {
            siteId: fixtures.siteId,
            path: `${slug}/child`,
            navigationMode: 'inherit',
            navigationId: sentinelNavId
          })

          const ancestorId = fixtures.siteId
          const ownNavId = folder.id
          const { navId: expectedNavId, cascadeTo: expectedCascadeTo } = expectedTransition(
            mode,
            wasCascading,
            ancestorId,
            ownNavId
          )

          const result = await navigationModel.updateNavigation({
            siteId: fixtures.siteId,
            pageId: folder.id,
            mode
          })

          assert.equal(result.navigationMode, mode)
          assert.equal(result.navigationId, expectedNavId)

          const [persistedFolder] = await fixtures.db
            .select()
            .from(treeTable)
            .where(eq(treeTable.id, folder.id))
          assert.equal(persistedFolder!.navigationMode, mode)
          assert.equal(persistedFolder!.navigationId, expectedNavId)

          const [persistedChild] = await fixtures.db
            .select()
            .from(treeTable)
            .where(eq(treeTable.id, child.id))
          if (expectedCascadeTo === undefined) {
            // -> No cascade UPDATE ran at all: the child's navigationId is exactly what it was
            //    seeded with, not merely "unchanged from some computed value".
            assert.equal(persistedChild!.navigationId, sentinelNavId)
          } else {
            assert.equal(persistedChild!.navigationId, expectedCascadeTo)
          }
          // -> Cascade never touches the mode column, only navigationId.
          assert.equal(persistedChild!.navigationMode, 'inherit')
        })
      }
    }
  })

  /**
   * `items`-target routing (navigation.ts:199-218): which menu a page's saved items land in is the
   * *mode's* answer, not the entry's own id — except when that would mean nowhere at all.
   */
  describe('updateNavigation items-target routing', () => {
    const items: NavigationItem[] = [{ id: 'x', type: 'link', label: 'X', target: '/x' }]

    test('mode=inherit writes items to the resolved ancestor menu, not a menu of its own', async () => {
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'inherit-items'
      })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: page.id,
        mode: 'inherit',
        items
      })

      // -> Top-level page: the resolved ancestor is the site menu, distinct from the page's own id.
      assert.equal(navigationId, fixtures.siteId)
      assert.notEqual(navigationId, page.id)
      assert.deepEqual(await navigationModel.getNav(fixtures.siteId, { unfiltered: true }), items)

      // -> No menu was ever created under the page's own id.
      const ownRow = await fixtures.db
        .select()
        .from(navigationTable)
        .where(eq(navigationTable.id, page.id))
      assert.equal(ownRow.length, 0)
    })

    test("a non-inherit mode (override) writes items to the entry's own menu, not the ancestor's", async () => {
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'override-items'
      })
      const siteItemsBefore = await navigationModel.getNav(fixtures.siteId, { unfiltered: true })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: page.id,
        mode: 'override',
        items
      })

      assert.equal(navigationId, page.id)
      assert.deepEqual(await navigationModel.getNav(page.id, { unfiltered: true }), items)
      // -> The site (ancestor) menu is untouched by a save that targeted the page's own menu.
      assert.deepEqual(
        await navigationModel.getNav(fixtures.siteId, { unfiltered: true }),
        siteItemsBefore
      )
    })

    test('mode=inherit under a hidden ancestor throws navNoInheritedMenu and writes nothing', async () => {
      const hiddenFolder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'hidden-parent-items',
        type: 'folder',
        navigationMode: 'hide',
        navigationId: null
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'hidden-parent-items/child',
        navigationMode: 'inherit',
        navigationId: null
      })
      assert.equal(await navigationModel.inheritedNavId(fixtures.siteId, page.id), null)

      await assert.rejects(
        navigationModel.updateNavigation({
          siteId: fixtures.siteId,
          pageId: page.id,
          mode: 'inherit',
          items
        }),
        (err: any) => {
          assert.equal(err.name, 'navNoInheritedMenu')
          assert.equal(err.statusCode, 400)
          return true
        }
      )

      // -> No menu row was ever created for the page (the throw happens before that insert).
      const ownRow = await fixtures.db
        .select()
        .from(navigationTable)
        .where(eq(navigationTable.id, page.id))
      assert.equal(ownRow.length, 0)

      // -> The tree update (navigationMode/navigationId, which runs after the items write) never
      //    ran either: the page is exactly as seeded.
      const [persistedPage] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, page.id))
      assert.equal(persistedPage!.navigationMode, 'inherit')
      assert.equal(persistedPage!.navigationId, null)
      void hiddenFolder
    })
  })

  /**
   * The site-root special case (navigation.ts:191-194): the home page (`folderPath === ''`,
   * `fileName === 'home'`) uses `siteId` as its `ownNavId`, so editing its items writes to the
   * site's own navigation row rather than a page-owned one. Each case uses a brand-new site, seeded
   * directly rather than through `setupTestDb()`'s shared fixture, so the navigation row's prior
   * state (absent vs. already populated) is exactly what the case controls.
   */
  describe('updateNavigation site-root special case (home page)', () => {
    async function createSite(): Promise<string> {
      const [site] = await fixtures.db
        .insert(sitesTable)
        .values({
          hostname: `test-${randomUUID()}.localhost`,
          isEnabled: true,
          config: { locales: { primary: 'en' } }
        })
        .returning({ id: sitesTable.id })
      return site!.id
    }

    test("fresh site: saving the home page items exercises ensureSiteNav's onConflictDoNothing insert", async () => {
      const siteId = await createSite()
      // -> Nothing has ever called ensureSiteNav for this site — confirm no navigation row exists yet.
      const beforeRow = await fixtures.db
        .select()
        .from(navigationTable)
        .where(eq(navigationTable.id, siteId))
      assert.equal(beforeRow.length, 0)

      const home = await seedTreeEntry(fixtures.db, { siteId, path: 'home' })
      const items: NavigationItem[] = [{ id: 'h', type: 'link', label: 'Home link', target: '/' }]

      const { navigationId } = await navigationModel.updateNavigation({
        siteId,
        pageId: home.id,
        mode: 'override',
        items
      })

      // -> ownNavId resolved to the site id, not the home page's own tree entry id.
      assert.equal(navigationId, siteId)
      assert.notEqual(navigationId, home.id)
      assert.deepEqual(await navigationModel.getNav(siteId, { unfiltered: true }), items)
      // -> Exactly one navigation row for this site — the insert path, not a duplicate.
      const afterRow = await fixtures.db
        .select()
        .from(navigationTable)
        .where(eq(navigationTable.id, siteId))
      assert.equal(afterRow.length, 1)
    })

    test('existing site nav row with prior items: saving home page items replaces rather than merges', async () => {
      const siteId = await createSite()
      const home = await seedTreeEntry(fixtures.db, { siteId, path: 'home' })
      const originalItems: NavigationItem[] = [
        { id: 'old-1', type: 'link', label: 'Old 1', target: '/old-1' },
        { id: 'old-2', type: 'link', label: 'Old 2', target: '/old-2' }
      ]
      await navigationModel.updateNavigation({
        siteId,
        pageId: home.id,
        mode: 'override',
        items: originalItems
      })
      assert.deepEqual(await navigationModel.getNav(siteId, { unfiltered: true }), originalItems)

      const replacementItems: NavigationItem[] = [
        { id: 'new-1', type: 'link', label: 'New 1', target: '/new-1' }
      ]
      const { navigationId } = await navigationModel.updateNavigation({
        siteId,
        pageId: home.id,
        mode: 'override',
        items: replacementItems
      })

      assert.equal(navigationId, siteId)
      // -> onConflictDoUpdate's `set: { items }` replaces the array outright — the old items are
      //    gone, not merged alongside the new one.
      assert.deepEqual(await navigationModel.getNav(siteId, { unfiltered: true }), replacementItems)
    })
  })
})
