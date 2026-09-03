import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'

import { pages as pagesTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { pageDrafts } from './pageDrafts.ts'

/**
 * `models/pageDrafts.ts` against a real Postgres instance (OpenProject #2455): the whole point of
 * this model is the upsert-by-page-id `save()` and the FK/cascade behaviour, exactly the kind of thing
 * a mock of the query builder would mostly just be re-describing rather than verifying.
 */
describe('pageDrafts (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pageId: string
  let otherPageId: string

  before(async () => {
    await ensureTemporal()
    fixtures = await setupTestDb()
    const rows = await WIKI.db
      .insert(pagesTable)
      .values([
        {
          siteId: fixtures.siteId,
          locale: 'en',
          path: 'draft-test-page',
          hash: 'draft-test-page',
          title: 'Draft Test Page',
          editor: 'markdown',
          contentType: 'markdown',
          authorId: fixtures.userId,
          creatorId: fixtures.userId,
          ownerId: fixtures.userId,
          classification: fixtures.classificationId
        },
        {
          siteId: fixtures.siteId,
          locale: 'en',
          path: 'draft-test-page-2',
          hash: 'draft-test-page-2',
          title: 'Draft Test Page 2',
          editor: 'markdown',
          contentType: 'markdown',
          authorId: fixtures.userId,
          creatorId: fixtures.userId,
          ownerId: fixtures.userId,
          classification: fixtures.classificationId
        }
      ])
      .returning({ id: pagesTable.id })
    pageId = rows[0].id
    otherPageId = rows[1].id
  })

  after(async () => {
    await teardownTestDb()
  })

  test('get() answers null for a page with no draft', async () => {
    assert.equal(await pageDrafts.get(otherPageId), null)
    assert.equal(await pageDrafts.summary(otherPageId), null)
  })

  test('save() then get() round-trips every field', async () => {
    await pageDrafts.save({
      pageId,
      content: 'unsaved content',
      title: 'Unsaved Title',
      description: 'Unsaved description',
      icon: 'mdi:file',
      authorId: fixtures.userId,
      authorName: 'Ada Lovelace'
    })

    const draft = await pageDrafts.get(pageId)
    assert.ok(draft)
    assert.equal(draft.content, 'unsaved content')
    assert.equal(draft.title, 'Unsaved Title')
    assert.equal(draft.description, 'Unsaved description')
    assert.equal(draft.icon, 'mdi:file')
    assert.equal(draft.authorId, fixtures.userId)
    assert.equal(draft.authorName, 'Ada Lovelace')
    assert.ok(draft.updatedAt instanceof Date)
  })

  test('summary() answers the lightweight existence check with no content', async () => {
    const summary = await pageDrafts.summary(pageId)
    assert.ok(summary)
    assert.equal(summary.authorName, 'Ada Lovelace')
    assert.ok(summary.updatedAt instanceof Date)
    assert.equal(Object.hasOwn(summary, 'content'), false)
  })

  test('save() a second time replaces the row rather than adding another', async () => {
    await pageDrafts.save({
      pageId,
      content: 'a newer unsaved edit',
      title: 'Newer Title',
      description: 'Newer description',
      icon: 'mdi:pencil',
      authorId: null,
      authorName: null
    })

    const draft = await pageDrafts.get(pageId)
    assert.ok(draft)
    assert.equal(draft.content, 'a newer unsaved edit')
    assert.equal(draft.title, 'Newer Title')
    assert.equal(draft.authorId, null)
    assert.equal(draft.authorName, null)
  })

  test('clear() removes the draft, and is a safe no-op when there was none', async () => {
    await pageDrafts.clear(pageId)
    assert.equal(await pageDrafts.get(pageId), null)

    // -> Idempotent: clearing again (or clearing a page that never had one) does not throw
    await pageDrafts.clear(pageId)
    await pageDrafts.clear(otherPageId)
  })

  test('deleting the page cascades to its draft', async () => {
    await pageDrafts.save({
      pageId: otherPageId,
      content: 'about to be orphaned',
      title: 'T',
      description: 'D',
      icon: 'mdi:file',
      authorId: null,
      authorName: null
    })
    assert.ok(await pageDrafts.get(otherPageId))

    await WIKI.db.delete(pagesTable).where(eq(pagesTable.id, otherPageId))
    assert.equal(await pageDrafts.get(otherPageId), null)
  })
})
