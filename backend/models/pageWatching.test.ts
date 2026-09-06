import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  groups as groupsTable,
  pageWatching as watchingTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import { initialsFor } from './pageWatching.ts'
import type { PageActor, PageInput } from './pages.ts'
import type { GroupRule } from './groups.ts'

/**
 * Task 530: the delivery preference on a watch — `watch()` accepting and persisting it,
 * `setPreference()` changing it after the fact, and the defaults every unset field resolves to.
 *
 * DB-backed rather than mocked: the interesting behavior is the unique-index-driven idempotency of
 * `watch()` (a second call must NOT clobber a preference already stored) and a partial `UPDATE` in
 * `setPreference()` (fields left out of the call must survive untouched) — both are properties of
 * the actual SQL, not of this file's own logic, so a stubbed query builder would only be testing that
 * the stub does what the stub was told to do.
 */
describe('pageWatching preferences (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pageWatchingModel: typeof import('./pageWatching.ts').pageWatching
  let pagesModel: typeof import('./pages.ts').pages
  let groupsModel: typeof import('./groups.ts').groups
  let resolvePreference: typeof import('./pageWatching.ts').resolvePreference
  let wantsAction: typeof import('./pageWatching.ts').wantsAction
  let actor: PageActor
  let pageId: string
  let watcherId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({
      pageWatching: pageWatchingModel,
      resolvePreference,
      wantsAction
    } = await import('./pageWatching.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ groups: groupsModel } = await import('./groups.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }

    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'preferences-fixture',
        title: 'Preferences Fixture',
        editor: 'markdown',
        content: '# Hi'
      } as PageInput,
      actor
    )
    pageId = page.id

    const [watcher] = await fixtures.db
      .insert(usersTable)
      .values({ email: 'watcher@example.com', name: 'Watcher', isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    watcherId = watcher!.id

    // -> The watcher is an ordinary reader, not an admin: put them in the fixture group and grant it
    //    a plain `read:pages` ALLOW everywhere, so `listWatchers`/`listForUser`'s OpenProject #2173
    //    read:pages re-check has something real to pass against (see the DENY-rule case below, which
    //    narrows this same rule to prove the check actually bites).
    await fixtures.db
      .insert(userGroupsTable)
      .values({ userId: watcherId, groupId: fixtures.groupId })
    await fixtures.db
      .update(groupsTable)
      .set({
        rules: [
          {
            id: 'watch-read-everywhere',
            name: 'Read everywhere',
            roles: ['read:pages'],
            match: 'START',
            mode: 'ALLOW',
            path: '',
            locales: [],
            sites: []
          } satisfies GroupRule
        ]
      })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()
  })

  after(async () => {
    await teardownTestDb()
  })

  test('watch() with no preference leaves every column null, and getPreference resolves defaults', async () => {
    await pageWatchingModel.watch({ siteId: fixtures.siteId, pageId, userId: watcherId })

    const preference = await pageWatchingModel.getPreference(pageId, watcherId)
    assert.deepEqual(preference, {
      notifyMode: 'digest',
      notifyOnEdited: true,
      notifyOnMoved: true,
      notifyOnDeleted: true
    })

    await pageWatchingModel.unwatch({ pageId, userId: watcherId })
  })

  test('watch() persists a preference passed on the first watch', async () => {
    await pageWatchingModel.watch({
      siteId: fixtures.siteId,
      pageId,
      userId: watcherId,
      notifyMode: 'immediate',
      notifyOnMoved: false
    })

    assert.deepEqual(await pageWatchingModel.getPreference(pageId, watcherId), {
      notifyMode: 'immediate',
      notifyOnEdited: true,
      notifyOnMoved: false,
      notifyOnDeleted: true
    })

    await pageWatchingModel.unwatch({ pageId, userId: watcherId })
  })

  test('watch() called again on an existing watch does not overwrite its stored preference', async () => {
    await pageWatchingModel.watch({
      siteId: fixtures.siteId,
      pageId,
      userId: watcherId,
      notifyMode: 'immediate'
    })

    // Re-watching (the button pressed twice) with a different preference in the body must be a no-op.
    await pageWatchingModel.watch({
      siteId: fixtures.siteId,
      pageId,
      userId: watcherId,
      notifyMode: 'digest'
    })

    const preference = await pageWatchingModel.getPreference(pageId, watcherId)
    assert.equal(preference?.notifyMode, 'immediate')

    await pageWatchingModel.unwatch({ pageId, userId: watcherId })
  })

  test('setPreference() partially updates: fields left out survive unchanged', async () => {
    await pageWatchingModel.watch({
      siteId: fixtures.siteId,
      pageId,
      userId: watcherId,
      notifyMode: 'immediate',
      notifyOnDeleted: false
    })

    const existed = await pageWatchingModel.setPreference({
      pageId,
      userId: watcherId,
      notifyOnEdited: false
    })
    assert.equal(existed, true)

    assert.deepEqual(await pageWatchingModel.getPreference(pageId, watcherId), {
      notifyMode: 'immediate',
      notifyOnEdited: false,
      notifyOnMoved: true,
      notifyOnDeleted: false
    })

    await pageWatchingModel.unwatch({ pageId, userId: watcherId })
  })

  test('setPreference() on a page nobody is watching returns false and creates nothing', async () => {
    const existed = await pageWatchingModel.setPreference({
      pageId,
      userId: watcherId,
      notifyMode: 'immediate'
    })
    assert.equal(existed, false)
    assert.equal(await pageWatchingModel.isWatching(pageId, watcherId), false)
  })

  test('listForUser resolves each row’s preference alongside the page it is joined to', async () => {
    await pageWatchingModel.watch({
      siteId: fixtures.siteId,
      pageId,
      userId: watcherId,
      notifyMode: 'immediate',
      notifyOnMoved: false
    })

    const [watched] = await pageWatchingModel.listForUser(fixtures.siteId, watcherId)
    assert.equal(watched?.pageId, pageId)
    assert.deepEqual(watched?.preference, {
      notifyMode: 'immediate',
      notifyOnEdited: true,
      notifyOnMoved: false,
      notifyOnDeleted: true
    })

    await pageWatchingModel.unwatch({ pageId, userId: watcherId })
  })

  test('a watcher who lost read:pages is excluded from listWatchers and from their own notification listing (OpenProject #2173)', async () => {
    await pageWatchingModel.watch({ siteId: fixtures.siteId, pageId, userId: watcherId })

    // -> Narrow the fixture group's blanket ALLOW with a DENY on this specific page, then reload the
    //    cache -- the same "revoked after subscribing" scenario the audit describes.
    await fixtures.db
      .update(groupsTable)
      .set({
        rules: [
          {
            id: 'watch-read-everywhere',
            name: 'Read everywhere',
            roles: ['read:pages'],
            match: 'START',
            mode: 'ALLOW',
            path: '',
            locales: [],
            sites: []
          },
          {
            id: 'watch-deny-this-page',
            name: 'Deny this page specifically',
            roles: ['read:pages'],
            match: 'EXACT',
            mode: 'DENY',
            path: 'preferences-fixture',
            locales: [],
            sites: []
          }
        ] satisfies GroupRule[]
      })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    try {
      const listed = await pageWatchingModel.listForUser(fixtures.siteId, watcherId)
      assert.equal(
        listed.some((row) => row.pageId === pageId),
        false,
        'a page the watcher lost read:pages on must not appear in their own watched-pages listing'
      )

      const watchers = await pageWatchingModel.listWatchers(
        fixtures.siteId,
        pageId,
        // -> `excludeUserId` -- some other actor's edit, not the watcher's own
        fixtures.userId,
        'updated'
      )
      assert.equal(
        watchers.some((w) => w.userId === watcherId),
        false,
        'a watcher who lost read:pages must not be queued a notification for this page'
      )
    } finally {
      // -> Restore the blanket ALLOW so no later test in this file inherits the narrowed rule.
      await fixtures.db
        .update(groupsTable)
        .set({
          rules: [
            {
              id: 'watch-read-everywhere',
              name: 'Read everywhere',
              roles: ['read:pages'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            } satisfies GroupRule
          ]
        })
        .where(eq(groupsTable.id, fixtures.groupId))
      await groupsModel.reloadCache()
      await pageWatchingModel.unwatch({ pageId, userId: watcherId })
    }
  })

  test('resolvePreference and wantsAction agree on which change types a resolved preference wants', () => {
    const preference = resolvePreference({ notifyOnMoved: false })
    assert.equal(wantsAction(preference, 'updated'), true)
    assert.equal(wantsAction(preference, 'moved'), false)
    assert.equal(wantsAction(preference, 'deleted'), true)
  })

  /**
   * OpenProject #2646: `listForPage`, the page metadata rail's Watching section.
   *
   * DB-backed for the same reason the rest of this file is: what is interesting here is the SQL — an
   * `ORDER BY createdAt` the rows are deliberately NOT inserted in, a `LIMIT` that must not reach the
   * `COUNT(*)`, and a join to `users` — none of which a stubbed query builder would verify.
   *
   * Rows are inserted straight into the table with explicit `createdAt` values rather than through
   * `watch()`: `watch()` stamps `defaultNow()`, so ordering would rest on how fast three statements
   * ran, which is not a property worth asserting on.
   */
  describe('listForPage', () => {
    let listPageId: string
    /** Insertion order is deliberately not watch order — the query has to do the sorting. */
    const NAMES = ['Grace Hopper', 'Ada Lovelace', 'Prince', '']
    /** `watchedAt` per name, so oldest-first is Ada, Prince, Grace, then the nameless account. */
    const WATCHED_AT: Record<string, Date> = {
      'Ada Lovelace': new Date('2026-01-01T00:00:00.000Z'),
      Prince: new Date('2026-02-01T00:00:00.000Z'),
      'Grace Hopper': new Date('2026-03-01T00:00:00.000Z'),
      '': new Date('2026-04-01T00:00:00.000Z')
    }

    before(async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'list-for-page-fixture',
          title: 'List For Page Fixture',
          editor: 'markdown',
          content: '# Hi'
        } as PageInput,
        actor
      )
      listPageId = page.id

      for (const [index, name] of NAMES.entries()) {
        const [user] = await fixtures.db
          .insert(usersTable)
          .values({
            email: `list-for-page-${index}@example.com`,
            name,
            isActive: true,
            isVerified: true
          })
          .returning({ id: usersTable.id })
        await fixtures.db.insert(watchingTable).values({
          siteId: fixtures.siteId,
          pageId: listPageId,
          userId: user!.id,
          createdAt: WATCHED_AT[name]!
        })
      }
    })

    test('returns watchers oldest first, with the name and initials of each', async () => {
      const { watchers } = await pageWatchingModel.listForPage(listPageId, { limit: 10 })

      assert.deepEqual(
        watchers.map((w) => w.name),
        ['Ada Lovelace', 'Prince', 'Grace Hopper', ''],
        'earliest to have started watching comes first, not most recent'
      )
      assert.deepEqual(
        watchers.map((w) => w.initials),
        ['AL', 'P', 'GH', '?'],
        'two letters for a full name, one for a mononym, and a neutral glyph for a nameless account'
      )
      assert.deepEqual(
        watchers.map((w) => w.watchedAt.toISOString()),
        [
          '2026-01-01T00:00:00.000Z',
          '2026-02-01T00:00:00.000Z',
          '2026-03-01T00:00:00.000Z',
          '2026-04-01T00:00:00.000Z'
        ]
      )
    })

    test('total counts every watcher, not the ones the limit returned', async () => {
      const { watchers, total } = await pageWatchingModel.listForPage(listPageId, { limit: 3 })

      assert.equal(watchers.length, 3, 'the limit truncates the returned rows')
      assert.equal(
        total,
        4,
        'and leaves the total alone, which is what a `+N` remainder counts from'
      )
      assert.deepEqual(
        watchers.map((w) => w.initials),
        ['AL', 'P', 'GH'],
        'the three returned are the three OLDEST, not an arbitrary three'
      )
    })

    test('a page nobody watches answers an empty list and a zero total', async () => {
      const unwatched = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'list-for-page-unwatched',
          title: 'Unwatched',
          editor: 'markdown',
          content: '# Hi'
        } as PageInput,
        actor
      )

      assert.deepEqual(await pageWatchingModel.listForPage(unwatched.id, { limit: 10 }), {
        watchers: [],
        total: 0
      })
    })

    test('another page’s watchers are not counted into this one', async () => {
      // -> The one thing a `WHERE pageId` typo would not otherwise show up as: `pageId` is the whole
      //    of the filter here (no `siteId`), so a missing predicate would total the entire table.
      const other = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'list-for-page-other',
          title: 'Other',
          editor: 'markdown',
          content: '# Hi'
        } as PageInput,
        actor
      )
      await pageWatchingModel.watch({
        siteId: fixtures.siteId,
        pageId: other.id,
        userId: fixtures.userId
      })

      assert.equal((await pageWatchingModel.listForPage(listPageId, { limit: 10 })).total, 4)
      assert.equal((await pageWatchingModel.listForPage(other.id, { limit: 10 })).total, 1)
    })

    test('a watcher who lost read:pages is still listed — this answers about the page, not about them', async () => {
      /*
        The deliberate difference from `listForUser`/`listWatchers`, which both drop such a watcher
        (OpenProject #2173). Those answer "what should this person see / be mailed"; this answers "who
        watches this page", asked by somebody else whose OWN read:pages the route has already checked.
        Asserted rather than left implicit, so a later "consistency" change has to argue with a test.
      */
      const [outsider] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'list-for-page-outsider@example.com',
          name: 'Out Sider',
          isActive: true,
          isVerified: true
        })
        .returning({ id: usersTable.id })
      // -> In no group at all, so no rule grants them `read:pages` anywhere.
      await fixtures.db.insert(watchingTable).values({
        siteId: fixtures.siteId,
        pageId: listPageId,
        userId: outsider!.id,
        createdAt: new Date('2026-05-01T00:00:00.000Z')
      })

      const { watchers, total } = await pageWatchingModel.listForPage(listPageId, { limit: 10 })
      assert.equal(total, 5)
      assert.equal(watchers.at(-1)?.name, 'Out Sider')

      await pageWatchingModel.unwatch({ pageId: listPageId, userId: outsider!.id })
    })
  })
})

/**
 * `initialsFor` is a pure function over a name, so it is tested without a database — the plate the
 * rail draws is exactly two letters, one letter, or a neutral glyph, and nothing else.
 */
describe('initialsFor (OpenProject #2646)', () => {
  test('takes the first and last word, uppercased', () => {
    assert.equal(initialsFor('Ada Lovelace'), 'AL')
    assert.equal(initialsFor('ada lovelace'), 'AL')
  })

  test('uses the FIRST and LAST word of a longer name, not the first two', () => {
    assert.equal(initialsFor('Ada King Lovelace'), 'AL')
  })

  test('gives a mononym its single letter', () => {
    assert.equal(initialsFor('Prince'), 'P')
  })

  test('collapses surrounding and interior whitespace rather than reading it as a word', () => {
    assert.equal(initialsFor('  Ada   Lovelace  '), 'AL')
    assert.equal(initialsFor('\tAda\nLovelace'), 'AL')
  })

  test('answers a neutral glyph for an empty, whitespace-only, null or undefined name', () => {
    assert.equal(initialsFor(''), '?')
    assert.equal(initialsFor('   '), '?')
    assert.equal(initialsFor(null), '?')
    assert.equal(initialsFor(undefined), '?')
  })
})
