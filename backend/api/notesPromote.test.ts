import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import {
  assets as assetsTable,
  groups as groupsTable,
  noteImages as noteImagesTable,
  noteSections as noteSectionsTable,
  notes as notesTable,
  pages as pagesTable,
  tree as treeTable,
  users as usersTable
} from '../db/schema.ts'
import type { GroupRule } from '../models/groups.ts'
import type { PageActor } from '../models/pages.ts'
import { noteImageUrl } from '../helpers/notePromotion.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import { ensureTemporal } from '../test/temporal.ts'
import notesPromoteRoutes from './notesPromote.ts'

const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NOTE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

describe('POST /sites/:siteId/notes/:noteId/promote (refusals before any write)', () => {
  let app: FastifyInstance
  let features: Record<string, unknown>
  let granted: Set<string>
  let session: any
  const transaction = mock.fn(async () => {
    throw new Error('the transaction must not be opened')
  })

  before(async () => {
    await ensureTemporal()
    const wiki = {
      db: { transaction },
      sites: {
        [SITE_ID]: {
          id: SITE_ID,
          config: {
            locales: { primary: 'en', active: ['en'] },
            get features() {
              return features
            }
          }
        }
      },
      models: {
        groups: {
          actorForRequest: () => ({ permissions: [], groupIds: [] }),
          groupIdsForRequest: () => [],
          checkAccess: (_actor: unknown, permission: string) => granted.has(permission)
        }
      }
    }
    app = await buildTestApp({
      routes: notesPromoteRoutes,
      ajv: true,
      wiki,
      session: () => session
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    features = {}
    granted = new Set(['write:pages', 'publish:pages', 'write:assets'])
    session = { authenticated: true, user: { id: USER_ID }, permissions: [], groups: [] }
    transaction.mock.resetCalls()
  })

  const promote = (body: Record<string, unknown> = { path: 'docs/idea', title: 'Idea' }) =>
    app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/notes/${NOTE_ID}/promote`,
      payload: body
    })

  test('a guest answers 401', async () => {
    session = undefined
    const res = await promote()
    assert.equal(res.statusCode, 401)
    assert.equal(transaction.mock.callCount(), 0)
  })

  test('a site with notes turned off answers 403 notesDisabled', async () => {
    features = { notes: false }
    const res = await promote()
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error, 'notesDisabled')
    assert.equal(transaction.mock.callCount(), 0)
  })

  test('no write:pages at the destination answers 403 without touching the note', async () => {
    granted.delete('write:pages')
    const res = await promote()
    assert.equal(res.statusCode, 403)
    assert.equal(transaction.mock.callCount(), 0)
  })

  test('a path and a title are required', async () => {
    const res = await promote({ path: 'docs/idea' })
    assert.equal(res.statusCode, 400)
    assert.equal(transaction.mock.callCount(), 0)
  })
})

describe(
  'POST /sites/:siteId/notes/:noteId/promote (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let app: FastifyInstance
    let session: any
    let otherUserId: string
    let sectionId: string

    const rules: GroupRule[] = [
      {
        id: 'rule-docs',
        name: 'Write docs',
        roles: ['read:pages', 'write:pages', 'publish:pages', 'read:assets', 'write:assets'],
        match: 'SUBTREE',
        mode: 'ALLOW',
        path: 'docs',
        locales: [],
        sites: []
      },
      {
        id: 'rule-nofiles',
        name: 'Pages but no files',
        roles: ['read:pages', 'write:pages', 'publish:pages'],
        match: 'SUBTREE',
        mode: 'ALLOW',
        path: 'nofiles',
        locales: [],
        sites: []
      }
    ]

    before(async () => {
      fixtures = await setupTestDb()
      const [other] = await fixtures.db
        .insert(usersTable)
        .values({ email: 'other@example.com', name: 'Other', isActive: true, isVerified: true })
        .returning({ id: usersTable.id })
      otherUserId = other!.id
      await fixtures.db
        .update(groupsTable)
        .set({ rules })
        .where(eq(groupsTable.id, fixtures.groupId))
      await CARDINAL.models.groups.reloadCache()
      const [section] = await fixtures.db
        .insert(noteSectionsTable)
        .values({ siteId: fixtures.siteId, userId: fixtures.userId, title: 'Inbox', position: 0 })
        .returning({ id: noteSectionsTable.id })
      sectionId = section!.id
      app = await buildTestApp({ routes: notesPromoteRoutes, ajv: true, session: () => session })
    })

    after(async () => {
      await closeTestApp(app)
      await teardownTestDb()
    })

    beforeEach(() => {
      asUser(fixtures.userId)
    })

    function asUser(userId: string) {
      session = {
        authenticated: true,
        user: { id: userId },
        permissions: [],
        groups: [fixtures.groupId]
      }
    }

    async function seedNote({
      userId = fixtures.userId,
      fileName = 'image.png',
      withImage = true,
      extraFileNames = [],
      extraContent = ''
    }: {
      userId?: string
      fileName?: string
      withImage?: boolean
      extraFileNames?: string[]
      extraContent?: string
    } = {}) {
      const ownSectionId =
        userId === fixtures.userId
          ? sectionId
          : (
              await fixtures.db
                .insert(noteSectionsTable)
                .values({ siteId: fixtures.siteId, userId, title: 'Theirs', position: 0 })
                .returning({ id: noteSectionsTable.id })
            )[0]!.id
      const [note] = await fixtures.db
        .insert(notesTable)
        .values({
          siteId: fixtures.siteId,
          userId,
          sectionId: ownSectionId,
          title: null,
          content: 'placeholder',
          position: 0
        })
        .returning({ id: notesTable.id })
      const noteId = note!.id
      let imageId: string | null = null
      let content = '# An idea\n\nWorth keeping.\n'
      if (withImage) {
        const [image] = await fixtures.db
          .insert(noteImagesTable)
          .values({
            noteId,
            userId,
            siteId: fixtures.siteId,
            fileName,
            mimeType: 'image/png',
            fileSize: PNG.length,
            data: PNG
          })
          .returning({ id: noteImagesTable.id })
        imageId = image!.id
        content += `\n![sketch](${noteImageUrl(fixtures.siteId, noteId, imageId)})\n`
      }
      for (const extraName of extraFileNames) {
        const [extra] = await fixtures.db
          .insert(noteImagesTable)
          .values({
            noteId,
            userId,
            siteId: fixtures.siteId,
            fileName: extraName,
            mimeType: 'image/png',
            fileSize: PNG.length,
            data: PNG
          })
          .returning({ id: noteImagesTable.id })
        content += `\n![extra](${noteImageUrl(fixtures.siteId, noteId, extra!.id)})\n`
      }
      content += extraContent
      const [row] = await fixtures.db
        .update(notesTable)
        .set({ content })
        .where(eq(notesTable.id, noteId))
        .returning({ updatedAt: notesTable.updatedAt })
      return {
        noteId,
        imageId,
        content,
        updatedAt: new Date(row!.updatedAt as unknown as string).toISOString()
      }
    }

    function renderOf(content: string): string {
      const src = /\((\/_api\/[^)]+)\)/.exec(content)?.[1]
      return `<h1>An idea</h1><p>Worth keeping.</p>${src ? `<p><img src="${src}" alt="sketch"></p>` : ''}`
    }

    async function promote(
      noteId: string,
      body: Record<string, unknown>
    ): Promise<{ statusCode: number; json: any }> {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${fixtures.siteId}/notes/${noteId}/promote`,
        payload: body
      })
      return { statusCode: res.statusCode, json: res.json() }
    }

    async function noteSurvives(noteId: string, imageId: string | null, content: string) {
      const [note] = await fixtures.db
        .select({ content: notesTable.content })
        .from(notesTable)
        .where(eq(notesTable.id, noteId))
      assert.equal(note?.content, content, 'the note is left exactly as it was')
      if (imageId) {
        const images = await fixtures.db
          .select({ id: noteImagesTable.id })
          .from(noteImagesTable)
          .where(eq(noteImagesTable.id, imageId))
        assert.equal(images.length, 1, 'the note image is still there')
      }
    }

    async function assetCount(): Promise<number> {
      return (await fixtures.db.select({ id: assetsTable.id }).from(assetsTable)).length
    }

    async function pageAt(path: string) {
      const [page] = await fixtures.db
        .select()
        .from(pagesTable)
        .where(and(eq(pagesTable.siteId, fixtures.siteId), eq(pagesTable.path, path)))
      return page
    }

    test('creates the page, re-homes the image beside it, and deletes the note', async () => {
      const note = await seedNote()
      const res = await promote(note.noteId, {
        path: 'docs/guides/idea',
        title: 'Idea',
        render: renderOf(note.content),
        noteUpdatedAt: note.updatedAt
      })
      assert.equal(res.statusCode, 200, JSON.stringify(res.json))
      assert.equal(res.json.path, 'docs/guides/idea')
      assert.equal(res.json.locale, 'en')
      assert.equal(res.json.images, 1)

      const page = await pageAt('docs/guides/idea')
      assert.ok(page)
      assert.equal(page.id, res.json.pageId)
      assert.equal(page.editor, 'wysiwyg')
      assert.equal(page.publishState, 'published')
      assert.match(page.content ?? '', /!\[sketch\]\(\/docs\/guides\/image\.png\)/)
      assert.doesNotMatch(page.content ?? '', /_api\/sites/)
      assert.match(page.render ?? '', /src="\/_files\/docs\/guides\/image\.png"/)
      assert.doesNotMatch(page.render ?? '', /_api\/sites/)

      const [asset] = await fixtures.db
        .select({ data: assetsTable.data, authorId: assetsTable.authorId })
        .from(assetsTable)
        .innerJoin(treeTable, eq(treeTable.id, assetsTable.id))
        .where(
          and(
            eq(treeTable.siteId, fixtures.siteId),
            eq(treeTable.fileName, 'image.png'),
            eq(treeTable.type, 'asset')
          )
        )
      assert.ok(asset, 'the image is now an asset in the page folder')
      assert.deepEqual(Buffer.from(asset.data as Buffer), PNG)
      assert.equal(asset.authorId, fixtures.userId)

      assert.equal(
        (await fixtures.db.select().from(notesTable).where(eq(notesTable.id, note.noteId))).length,
        0
      )
      assert.equal(
        (
          await fixtures.db
            .select()
            .from(noteImagesTable)
            .where(eq(noteImagesTable.id, note.imageId!))
        ).length,
        0
      )
    })

    test('a destination already holding a page answers 409 and changes nothing', async () => {
      const actor: PageActor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
      await CARDINAL.models.pages.createPage(
        fixtures.siteId,
        {
          path: 'docs/taken',
          title: 'Taken',
          editor: 'markdown',
          content: 'here first',
          render: '<p>here first</p>'
        },
        actor
      )
      const note = await seedNote()
      const assetsBefore = await assetCount()
      const res = await promote(note.noteId, { path: 'docs/taken', title: 'Idea' })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json.error, 'pageDuplicatePath')
      await noteSurvives(note.noteId, note.imageId, note.content)
      assert.equal(await assetCount(), assetsBefore)
    })

    test('no write:pages at the destination answers 403 and changes nothing', async () => {
      const note = await seedNote()
      const res = await promote(note.noteId, { path: 'secret/idea', title: 'Idea' })
      assert.equal(res.statusCode, 403)
      await noteSurvives(note.noteId, note.imageId, note.content)
      assert.equal(await pageAt('secret/idea'), undefined)
    })

    test('no write:assets for the images answers 403 and creates no page', async () => {
      const note = await seedNote()
      const assetsBefore = await assetCount()
      const res = await promote(note.noteId, { path: 'nofiles/idea', title: 'Idea' })
      assert.equal(res.statusCode, 403)
      assert.equal(res.json.error, 'notePromoteAssetsForbidden')
      await noteSurvives(note.noteId, note.imageId, note.content)
      assert.equal(await pageAt('nofiles/idea'), undefined)
      assert.equal(await assetCount(), assetsBefore)
    })

    test('a note without images needs no write:assets', async () => {
      const note = await seedNote({ withImage: false })
      const res = await promote(note.noteId, {
        path: 'nofiles/plain',
        title: 'Plain',
        render: renderOf(note.content),
        noteUpdatedAt: note.updatedAt
      })
      assert.equal(res.statusCode, 200, JSON.stringify(res.json))
      assert.equal(res.json.images, 0)
    })

    test("another user's note answers 404 and stays theirs", async () => {
      const note = await seedNote({ userId: otherUserId })
      const res = await promote(note.noteId, { path: 'docs/stolen', title: 'Stolen' })
      assert.equal(res.statusCode, 404)
      await noteSurvives(note.noteId, note.imageId, note.content)
      assert.equal(await pageAt('docs/stolen'), undefined)
    })

    test('a note saved after the render was made answers 409 noteChanged', async () => {
      const note = await seedNote()
      const res = await promote(note.noteId, {
        path: 'docs/stale',
        title: 'Stale',
        render: renderOf(note.content),
        noteUpdatedAt: '2000-01-01T00:00:00.000Z'
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json.error, 'noteChanged')
      await noteSurvives(note.noteId, note.imageId, note.content)
    })

    test("never overwrites a file already in the page's folder, whatever the site's conflict behavior", async () => {
      const site = CARDINAL.sites[fixtures.siteId]!
      const previousConfig = site.config
      site.config = {
        ...(previousConfig as Record<string, any>),
        uploads: { conflictBehavior: 'overwrite' }
      }
      try {
        const folder = await CARDINAL.models.tree.getFolder({
          path: 'docs/shared',
          locale: 'en',
          siteId: fixtures.siteId,
          createIfMissing: true
        })
        const original = Buffer.from('not the note image')
        const existing = await CARDINAL.models.assets.upload({
          siteId: fixtures.siteId,
          locale: 'en',
          folderId: folder.id,
          fileName: 'photo.png',
          data: original,
          authorId: fixtures.userId
        })
        const note = await seedNote({ fileName: 'photo.png' })
        const res = await promote(note.noteId, {
          path: 'docs/shared/idea',
          title: 'Idea',
          render: renderOf(note.content),
          noteUpdatedAt: note.updatedAt
        })
        assert.equal(res.statusCode, 200, JSON.stringify(res.json))

        const [kept] = await fixtures.db
          .select({ data: assetsTable.data })
          .from(assetsTable)
          .where(eq(assetsTable.id, existing.id))
        assert.deepEqual(Buffer.from(kept!.data as Buffer), original)
        const page = await pageAt('docs/shared/idea')
        assert.match(page?.content ?? '', /\(\/docs\/shared\/photo-1\.png\)/)
      } finally {
        site.config = previousConfig
      }
    })

    test('an image that cannot be stored after the page is written rolls everything back', async () => {
      const note = await seedNote({ extraFileNames: ['???'] })
      const assetsBefore = await assetCount()
      const res = await promote(note.noteId, { path: 'docs/broken/idea', title: 'Idea' })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json.error, 'assetInvalidFileName')
      await noteSurvives(note.noteId, note.imageId, note.content)
      assert.equal(await pageAt('docs/broken/idea'), undefined)
      assert.equal(await assetCount(), assetsBefore)
      const folders = await fixtures.db
        .select({ id: treeTable.id })
        .from(treeTable)
        .where(and(eq(treeTable.siteId, fixtures.siteId), eq(treeTable.fileName, 'broken')))
      assert.equal(folders.length, 0, 'the folder the page needed is rolled back too')
    })

    test("an image pasted in from another of the caller's notes is copied and stays with that note", async () => {
      const source = await seedNote({ fileName: 'borrowed.png' })
      const note = await seedNote({
        withImage: false,
        extraContent: `\n![borrowed](${noteImageUrl(fixtures.siteId, source.noteId, source.imageId!)})\n`
      })
      const res = await promote(note.noteId, {
        path: 'docs/borrowing',
        title: 'Borrowing',
        render: renderOf(note.content),
        noteUpdatedAt: note.updatedAt
      })
      assert.equal(res.statusCode, 200, JSON.stringify(res.json))
      assert.equal(res.json.images, 1)
      const page = await pageAt('docs/borrowing')
      assert.match(page?.content ?? '', /!\[borrowed\]\(\/docs\/borrowed\.png\)/)
      await noteSurvives(source.noteId, source.imageId, source.content)
    })

    test("another user's image pasted into the caller's note is left alone", async () => {
      const theirs = await seedNote({ userId: otherUserId, fileName: 'theirs.png' })
      const foreignUrl = noteImageUrl(fixtures.siteId, theirs.noteId, theirs.imageId!)
      const note = await seedNote({
        withImage: false,
        extraContent: `\n![theirs](${foreignUrl})\n`
      })
      const res = await promote(note.noteId, {
        path: 'docs/not-theirs',
        title: 'Not theirs',
        render: renderOf(note.content),
        noteUpdatedAt: note.updatedAt
      })
      assert.equal(res.statusCode, 200, JSON.stringify(res.json))
      assert.equal(res.json.images, 0)
      const page = await pageAt('docs/not-theirs')
      assert.ok(page?.content?.includes(foreignUrl))
      await noteSurvives(theirs.noteId, theirs.imageId, theirs.content)
    })
  }
)
