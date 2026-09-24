import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { makeActor } from '../test/builders.ts'
import {
  groups as groupsTable,
  sites as sitesTable,
  userGroups as userGroupsTable,
  userPages as userPagesTable,
  users as usersTable
} from '../db/schema.ts'
import type { PageInput } from './pages.ts'
import type { GroupRule } from './groups.ts'
import type { UserPageKind } from './userPages.ts'

describe('userPages (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let userPagesModel: typeof import('./userPages.ts').userPages
  let pagesModel: typeof import('./pages.ts').pages
  let groupsModel: typeof import('./groups.ts').groups
  let readerId: string
  let otherSiteId: string
  let otherSitePageId: string
  const pageIds: string[] = []

  const readEverywhere: GroupRule = {
    id: 'user-pages-read-everywhere',
    name: 'Read everywhere',
    roles: ['read:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: [],
    sites: []
  }

  async function setRules(rules: GroupRule[]) {
    await fixtures.db.update(groupsTable).set({ rules }).where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()
  }

  before(async () => {
    fixtures = await setupTestDb()
    ;({ userPages: userPagesModel } = await import('./userPages.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ groups: groupsModel } = await import('./groups.ts'))
    const admin = makeActor({
      id: fixtures.userId,
      permissions: ['manage:system']
    })

    for (const n of [1, 2, 3, 4]) {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: `user-pages-${n}`,
          title: `User Pages ${n}`,
          editor: 'markdown',
          content: '# Hi'
        } as PageInput,
        admin
      )
      pageIds.push(page.id)
    }

    const [otherSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'other.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en', active: ['en'] } }
      })
      .returning()
    otherSiteId = otherSite!.id
    CARDINAL.sites[otherSiteId] = otherSite! as any
    const otherPage = await pagesModel.createPage(
      otherSiteId,
      {
        path: 'other-site-page',
        title: 'Other Site Page',
        editor: 'markdown',
        content: '# Hi'
      } as PageInput,
      admin
    )
    otherSitePageId = otherPage.id

    const [reader] = await fixtures.db
      .insert(usersTable)
      .values({ email: 'reader@example.com', name: 'Reader', isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    readerId = reader!.id
    await fixtures.db
      .insert(userGroupsTable)
      .values({ userId: readerId, groupId: fixtures.groupId })
    await setRules([readEverywhere])
  })

  after(async () => {
    await teardownTestDb()
  })

  beforeEach(async () => {
    await fixtures.db.delete(userPagesTable)
    await setRules([readEverywhere])
  })

  const ids = (entries: { pageId: string }[]) => entries.map((entry) => entry.pageId)

  // -> A session's view: the user's own group membership, with no credential narrowing it
  const listAsUser = async (args: { siteId: string; userId: string; kind: UserPageKind }) =>
    userPagesModel.list({ ...args, actor: await groupsModel.actorForUserId(args.userId) })

  test('touchRecent lists most recently visited first and a revisit moves the page back to the top', async () => {
    const [a, b, c] = pageIds as [string, string, string]
    for (const pageId of [a, b, c]) {
      await userPagesModel.touchRecent({ siteId: fixtures.siteId, userId: readerId, pageId })
    }
    assert.deepEqual(
      ids(await listAsUser({ siteId: fixtures.siteId, userId: readerId, kind: 'recent' })),
      [c, b, a]
    )

    await userPagesModel.touchRecent({ siteId: fixtures.siteId, userId: readerId, pageId: a })
    assert.deepEqual(
      ids(await listAsUser({ siteId: fixtures.siteId, userId: readerId, kind: 'recent' })),
      [a, c, b],
      'a revisit updates the existing row rather than adding a second one'
    )
  })

  test('touchRecent trims the oldest recents beyond the cap', async () => {
    const [a, b, c, d] = pageIds as [string, string, string, string]
    for (const pageId of [a, b, c, d]) {
      await userPagesModel.touchRecent({
        siteId: fixtures.siteId,
        userId: readerId,
        pageId,
        cap: 3
      })
    }
    assert.deepEqual(
      ids(await listAsUser({ siteId: fixtures.siteId, userId: readerId, kind: 'recent' })),
      [d, c, b]
    )
  })

  test('trimming recents leaves favorites and pins alone', async () => {
    const [a, b, c] = pageIds as [string, string, string]
    await userPagesModel.add({
      siteId: fixtures.siteId,
      userId: readerId,
      pageId: a,
      kind: 'favorite'
    })
    await userPagesModel.add({
      siteId: fixtures.siteId,
      userId: readerId,
      pageId: a,
      kind: 'pinned'
    })
    for (const pageId of [a, b, c]) {
      await userPagesModel.touchRecent({
        siteId: fixtures.siteId,
        userId: readerId,
        pageId,
        cap: 1
      })
    }
    assert.deepEqual(
      ids(await listAsUser({ siteId: fixtures.siteId, userId: readerId, kind: 'recent' })),
      [c]
    )
    assert.deepEqual(
      ids(await listAsUser({ siteId: fixtures.siteId, userId: readerId, kind: 'favorite' })),
      [a]
    )
    assert.deepEqual(
      ids(await listAsUser({ siteId: fixtures.siteId, userId: readerId, kind: 'pinned' })),
      [a]
    )
  })

  test('the cap is per user: another user’s recents are not trimmed', async () => {
    const [a, b] = pageIds as [string, string]
    await userPagesModel.touchRecent({
      siteId: fixtures.siteId,
      userId: fixtures.userId,
      pageId: a
    })
    await userPagesModel.touchRecent({
      siteId: fixtures.siteId,
      userId: readerId,
      pageId: a,
      cap: 1
    })
    await userPagesModel.touchRecent({
      siteId: fixtures.siteId,
      userId: readerId,
      pageId: b,
      cap: 1
    })
    const rows = await fixtures.db
      .select()
      .from(userPagesTable)
      .where(eq(userPagesTable.userId, fixtures.userId))
    assert.equal(rows.length, 1)
  })

  test('add is idempotent and pins are listed in the order they were pinned', async () => {
    const [a, b, c] = pageIds as [string, string, string]
    for (const pageId of [b, a, c, b]) {
      await userPagesModel.add({
        siteId: fixtures.siteId,
        userId: readerId,
        pageId,
        kind: 'pinned'
      })
    }
    const pins = await listAsUser({
      siteId: fixtures.siteId,
      userId: readerId,
      kind: 'pinned'
    })
    assert.deepEqual(ids(pins), [b, a, c])
    assert.deepEqual(
      pins.map((pin) => pin.position),
      [0, 1, 2]
    )
  })

  test('remove reports whether a row existed and touches only the named kind', async () => {
    const [a] = pageIds as [string]
    await userPagesModel.add({
      siteId: fixtures.siteId,
      userId: readerId,
      pageId: a,
      kind: 'favorite'
    })
    await userPagesModel.add({
      siteId: fixtures.siteId,
      userId: readerId,
      pageId: a,
      kind: 'pinned'
    })

    assert.equal(
      await userPagesModel.remove({ userId: readerId, pageId: a, kind: 'favorite' }),
      true
    )
    assert.equal(
      await userPagesModel.remove({ userId: readerId, pageId: a, kind: 'favorite' }),
      false
    )
    assert.deepEqual(
      ids(await listAsUser({ siteId: fixtures.siteId, userId: readerId, kind: 'pinned' })),
      [a]
    )
  })

  test('lists are isolated by site', async () => {
    const [a] = pageIds as [string]
    await userPagesModel.touchRecent({ siteId: fixtures.siteId, userId: readerId, pageId: a })
    await userPagesModel.touchRecent({
      siteId: otherSiteId,
      userId: readerId,
      pageId: otherSitePageId
    })
    await userPagesModel.add({
      siteId: otherSiteId,
      userId: readerId,
      pageId: otherSitePageId,
      kind: 'favorite'
    })

    assert.deepEqual(
      ids(await listAsUser({ siteId: fixtures.siteId, userId: readerId, kind: 'recent' })),
      [a]
    )
    assert.deepEqual(
      ids(await listAsUser({ siteId: otherSiteId, userId: readerId, kind: 'recent' })),
      [otherSitePageId]
    )
    assert.deepEqual(
      await listAsUser({ siteId: fixtures.siteId, userId: readerId, kind: 'favorite' }),
      []
    )
  })

  test('the recents cap counts each site separately', async () => {
    const [a, b] = pageIds as [string, string]
    await userPagesModel.touchRecent({
      siteId: fixtures.siteId,
      userId: readerId,
      pageId: a,
      cap: 1
    })
    await userPagesModel.touchRecent({
      siteId: otherSiteId,
      userId: readerId,
      pageId: otherSitePageId,
      cap: 1
    })
    await userPagesModel.touchRecent({
      siteId: fixtures.siteId,
      userId: readerId,
      pageId: b,
      cap: 1
    })

    assert.deepEqual(
      ids(await listAsUser({ siteId: fixtures.siteId, userId: readerId, kind: 'recent' })),
      [b]
    )
    assert.deepEqual(
      ids(await listAsUser({ siteId: otherSiteId, userId: readerId, kind: 'recent' })),
      [otherSitePageId]
    )
  })

  test('list drops a page the user no longer has read:pages on, without failing the rest', async () => {
    const [a, b] = pageIds as [string, string]
    for (const kind of ['favorite', 'pinned'] as const) {
      for (const pageId of [a, b]) {
        await userPagesModel.add({ siteId: fixtures.siteId, userId: readerId, pageId, kind })
      }
    }
    for (const pageId of [a, b]) {
      await userPagesModel.touchRecent({ siteId: fixtures.siteId, userId: readerId, pageId })
    }

    await setRules([
      readEverywhere,
      {
        id: 'user-pages-deny-a',
        name: 'Deny one page',
        roles: ['read:pages'],
        match: 'EXACT',
        mode: 'DENY',
        path: 'user-pages-1',
        locales: [],
        sites: []
      }
    ])

    for (const kind of ['recent', 'favorite', 'pinned'] as const) {
      const listed = await listAsUser({ siteId: fixtures.siteId, userId: readerId, kind })
      assert.deepEqual(ids(listed), [b], `${kind} must not surface a page the user cannot read`)
    }
  })

  test('list returns nothing for a user whose groups grant no read:pages', async () => {
    const [a] = pageIds as [string]
    await userPagesModel.add({
      siteId: fixtures.siteId,
      userId: readerId,
      pageId: a,
      kind: 'favorite'
    })
    await setRules([])
    assert.deepEqual(
      await listAsUser({ siteId: fixtures.siteId, userId: readerId, kind: 'favorite' }),
      []
    )
  })

  test('list is filtered as the asking actor, so an API key’s narrowings hold', async () => {
    const [a, b] = pageIds as [string, string]
    for (const pageId of [a, b]) {
      await userPagesModel.add({
        siteId: fixtures.siteId,
        userId: readerId,
        pageId,
        kind: 'favorite'
      })
    }
    const member = await groupsModel.actorForUserId(readerId)
    const favoritesAs = async (actor: typeof member) =>
      ids(
        await userPagesModel.list({
          siteId: fixtures.siteId,
          userId: readerId,
          kind: 'favorite',
          actor
        })
      ).sort()

    assert.deepEqual(await favoritesAs(member), [a, b].sort())
    assert.deepEqual(
      await favoritesAs({ ...member, scope: ['read:comments'] }),
      [],
      'a key scoped away from read:pages lists nothing'
    )
    assert.deepEqual(
      await favoritesAs({ ...member, allowedClassifications: [] }),
      [],
      'a key allowed no classification lists nothing'
    )
    assert.deepEqual(
      await favoritesAs({ ...member, siteId: otherSiteId }),
      [],
      'a key pinned to another site lists nothing here'
    )
  })

  test('rows go with the page and with the user', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'user-pages-doomed',
        title: 'Doomed',
        editor: 'markdown',
        content: '# Hi'
      } as PageInput,
      makeActor({ id: fixtures.userId, permissions: ['manage:system'] })
    )
    await userPagesModel.add({
      siteId: fixtures.siteId,
      userId: readerId,
      pageId: page.id,
      kind: 'favorite'
    })
    await pagesModel.deletePage(
      fixtures.siteId,
      page.id,
      makeActor({ id: fixtures.userId, permissions: ['manage:system'] })
    )
    assert.deepEqual(
      await fixtures.db.select().from(userPagesTable).where(eq(userPagesTable.pageId, page.id)),
      []
    )
  })
})
