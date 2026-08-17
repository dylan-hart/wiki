import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  hasTestDatabase,
  seedTreeEntry,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import type { NavigationItem } from './navigation.ts'

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
})
