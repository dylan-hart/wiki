import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  noteSections as noteSectionsTable,
  notes as notesTable,
  sites as sitesTable,
  users as usersTable
} from '../db/schema.ts'
import { searchNotes } from './notesSearch.ts'

describe('searchNotes (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let otherUserId: string
  let otherSiteId: string
  let mineId: string
  let titledId: string
  let wildcardId: string

  async function addNote(
    siteId: string,
    userId: string,
    { title, content }: { title: string | null; content: string }
  ): Promise<string> {
    const [section] = await fixtures.db
      .insert(noteSectionsTable)
      .values({ siteId, userId, title: 'Section', position: 0 })
      .returning({ id: noteSectionsTable.id })
    const [note] = await fixtures.db
      .insert(notesTable)
      .values({ siteId, userId, sectionId: section!.id, title, content, position: 0 })
      .returning({ id: notesTable.id })
    return note!.id
  }

  before(async () => {
    fixtures = await setupTestDb()
    const [other] = await fixtures.db
      .insert(usersTable)
      .values({ email: 'other@example.com', name: 'Other', isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    otherUserId = other!.id
    const [site] = await fixtures.db
      .insert(sitesTable)
      .values({ hostname: 'notes-other.localhost', isEnabled: true, config: {} })
      .returning({ id: sitesTable.id })
    otherSiteId = site!.id

    mineId = await addNote(fixtures.siteId, fixtures.userId, {
      title: null,
      content: 'Buy oat milk and bread'
    })
    titledId = await addNote(fixtures.siteId, fixtures.userId, {
      title: 'Quarterly planning',
      content: 'Nothing about dairy here'
    })
    wildcardId = await addNote(fixtures.siteId, fixtures.userId, {
      title: null,
      content: 'Discount 50% off'
    })
    await addNote(fixtures.siteId, otherUserId, { title: 'milk', content: 'milk milk milk' })
    await addNote(otherSiteId, fixtures.userId, { title: 'milk', content: 'milk on another site' })
  })

  after(async () => {
    await teardownTestDb()
  })

  function search(query: string, limit?: number) {
    return searchNotes({ siteId: fixtures.siteId, userId: fixtures.userId, query, limit })
  }

  test('finds only the caller’s own notes on this site', async () => {
    const rows = await search('milk')

    assert.deepEqual(
      rows.map((r) => r.id),
      [mineId]
    )
  })

  test('another user searching sees none of the caller’s notes', async () => {
    const rows = await searchNotes({
      siteId: fixtures.siteId,
      userId: otherUserId,
      query: 'oat'
    })

    assert.deepEqual(rows, [])
  })

  test('matches the title as well as the content', async () => {
    const rows = await search('quarterly')

    assert.deepEqual(
      rows.map((r) => [r.id, r.title]),
      [[titledId, 'Quarterly planning']]
    )
  })

  test('matches part of a word', async () => {
    const rows = await search('plann')

    assert.deepEqual(
      rows.map((r) => r.id),
      [titledId]
    )
  })

  test('treats LIKE wildcards in the query literally', async () => {
    assert.deepEqual(
      (await search('50%')).map((r) => r.id),
      [wildcardId]
    )
    assert.deepEqual(await search('_'), [])
  })

  test('an empty query answers nothing', async () => {
    assert.deepEqual(await search('   '), [])
  })

  test('honours the limit', async () => {
    const rows = await searchNotes({
      siteId: fixtures.siteId,
      userId: fixtures.userId,
      query: 'a',
      limit: 1
    })

    assert.equal(rows.length, 1)
  })
})
