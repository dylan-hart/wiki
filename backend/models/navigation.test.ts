import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
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
})
