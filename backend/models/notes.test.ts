import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  noteImages as noteImagesTable,
  noteSections as noteSectionsTable,
  notes as notesTable,
  sites as sitesTable,
  users as usersTable
} from '../db/schema.ts'
import { NOTE_IMAGE_QUOTA_BYTES } from '../helpers/noteContent.ts'
import { mergeOrder, NoteConflictError } from './notes.ts'

describe('mergeOrder', () => {
  test('puts the requested ids first and keeps the rest in their current order', () => {
    assert.deepEqual(mergeOrder(['a', 'b', 'c', 'd'], ['c', 'a']), ['c', 'a', 'b', 'd'])
    assert.deepEqual(mergeOrder(['a', 'b'], ['b', 'a']), ['b', 'a'])
    assert.deepEqual(mergeOrder(['a', 'b'], []), ['a', 'b'])
  })

  test('refuses an id that is not owned', () => {
    assert.equal(mergeOrder(['a', 'b'], ['a', 'x']), null)
  })
})

describe('notes (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let notesModel: typeof import('./notes.ts').notes
  let otherUserId: string
  let otherSiteId: string

  async function createUser(email: string): Promise<string> {
    const [user] = await fixtures.db
      .insert(usersTable)
      .values({ email, name: email, isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    return user!.id
  }

  async function createSite(hostname: string): Promise<string> {
    const [site] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname,
        isEnabled: true,
        config: { locales: { primary: 'en', active: ['en'] } }
      })
      .returning()
    CARDINAL.sites[site!.id] = site! as any
    return site!.id
  }

  before(async () => {
    fixtures = await setupTestDb()
    ;({ notes: notesModel } = await import('./notes.ts'))
    otherUserId = await createUser('notes-other@example.com')
    otherSiteId = await createSite('notes-other.localhost')
  })

  after(async () => {
    await teardownTestDb()
  })

  describe('sections', () => {
    test('append in creation order and are listed only to their owner on their site', async () => {
      const userId = await createUser('sections-order@example.com')
      const a = await notesModel.createSection(fixtures.siteId, userId, { title: '  Work  ' })
      const b = await notesModel.createSection(fixtures.siteId, userId, { title: 'Home' })
      const c = await notesModel.createSection(fixtures.siteId, userId, { title: 'Ideas' })
      assert.equal(a.title, 'Work')
      assert.deepEqual(
        [a.position, b.position, c.position],
        [0, 1, 2],
        'each new section goes after the last'
      )

      const listed = await notesModel.listSections(fixtures.siteId, userId)
      assert.deepEqual(
        listed.map((s) => s.id),
        [a.id, b.id, c.id]
      )
      assert.deepEqual(await notesModel.listSections(fixtures.siteId, otherUserId), [])
      assert.deepEqual(await notesModel.listSections(otherSiteId, userId), [])
    })

    test('update and delete refuse another owner, another site and a malformed id', async () => {
      const section = await notesModel.createSection(fixtures.siteId, fixtures.userId, {
        title: 'Mine'
      })

      assert.equal(
        await notesModel.updateSection(fixtures.siteId, otherUserId, section.id, { title: 'X' }),
        null
      )
      assert.equal(
        await notesModel.updateSection(otherSiteId, fixtures.userId, section.id, { title: 'X' }),
        null
      )
      assert.equal(
        await notesModel.updateSection(fixtures.siteId, fixtures.userId, 'not-a-uuid', {
          title: 'X'
        }),
        null
      )
      assert.equal(await notesModel.deleteSection(fixtures.siteId, otherUserId, section.id), false)
      assert.equal(await notesModel.deleteSection(otherSiteId, fixtures.userId, section.id), false)
      assert.equal(
        await notesModel.deleteSection(fixtures.siteId, fixtures.userId, randomUUID()),
        false
      )

      const renamed = await notesModel.updateSection(fixtures.siteId, fixtures.userId, section.id, {
        title: 'Renamed'
      })
      assert.equal(renamed?.title, 'Renamed')
      assert.equal(
        await notesModel.deleteSection(fixtures.siteId, fixtures.userId, section.id),
        true
      )
    })

    test('reorder applies a full or partial order and refuses any foreign or repeated id whole', async () => {
      const userId = await createUser('sections-reorder@example.com')
      const [a, b, c] = [
        await notesModel.createSection(fixtures.siteId, userId, { title: 'A' }),
        await notesModel.createSection(fixtures.siteId, userId, { title: 'B' }),
        await notesModel.createSection(fixtures.siteId, userId, { title: 'C' })
      ]
      const foreign = await notesModel.createSection(fixtures.siteId, otherUserId, {
        title: 'Foreign'
      })
      const ids = async () =>
        (await notesModel.listSections(fixtures.siteId, userId)).map((s) => s.id)

      assert.equal(
        await notesModel.reorderSections(fixtures.siteId, userId, [c.id, a.id, b.id]),
        true
      )
      assert.deepEqual(await ids(), [c.id, a.id, b.id])

      assert.equal(await notesModel.reorderSections(fixtures.siteId, userId, [b.id]), true)
      assert.deepEqual(await ids(), [b.id, c.id, a.id])

      assert.equal(
        await notesModel.reorderSections(fixtures.siteId, userId, [a.id, foreign.id]),
        false
      )
      assert.equal(await notesModel.reorderSections(otherSiteId, userId, [a.id]), false)
      assert.equal(await notesModel.reorderSections(fixtures.siteId, userId, [a.id, a.id]), false)
      assert.equal(await notesModel.reorderSections(fixtures.siteId, userId, ['nope']), false)
      assert.deepEqual(await ids(), [b.id, c.id, a.id], 'a refused reorder changes nothing')
    })
  })

  describe('notes', () => {
    test('create in an owned section only, listed with an excerpt and without content', async () => {
      const userId = await createUser('notes-create@example.com')
      const section = await notesModel.createSection(fixtures.siteId, userId, { title: 'S' })
      const foreignSection = await notesModel.createSection(fixtures.siteId, otherUserId, {
        title: 'F'
      })

      const untitled = await notesModel.createNote(fixtures.siteId, userId, {
        sectionId: section.id,
        content: '\n# Groceries\n- milk'
      })
      const titled = await notesModel.createNote(fixtures.siteId, userId, {
        sectionId: section.id,
        title: '  Plan  '
      })
      assert.ok(untitled && titled)
      assert.equal(untitled.title, null)
      assert.equal(untitled.excerpt, 'Groceries')
      assert.equal(untitled.content, '\n# Groceries\n- milk')
      assert.equal(titled.title, 'Plan')
      assert.equal(titled.content, '')
      assert.deepEqual([untitled.position, titled.position], [0, 1])

      assert.equal(
        await notesModel.createNote(fixtures.siteId, userId, { sectionId: foreignSection.id }),
        null
      )
      assert.equal(
        await notesModel.createNote(otherSiteId, userId, { sectionId: section.id }),
        null
      )
      assert.equal(await notesModel.createNote(fixtures.siteId, userId, { sectionId: 'bad' }), null)

      const listed = await notesModel.listNotes(fixtures.siteId, userId, section.id)
      assert.deepEqual(
        listed?.map((n) => [n.id, n.excerpt]),
        [
          [untitled.id, 'Groceries'],
          [titled.id, '']
        ]
      )
      assert.ok(!('content' in listed![0]!), 'the list never carries content')
      assert.equal(await notesModel.listNotes(fixtures.siteId, otherUserId, section.id), null)
      assert.equal(await notesModel.listNotes(otherSiteId, userId, section.id), null)
    })

    test('get, update and delete answer null or false for another owner or site', async () => {
      const section = await notesModel.createSection(fixtures.siteId, fixtures.userId, {
        title: 'Private'
      })
      const note = (await notesModel.createNote(fixtures.siteId, fixtures.userId, {
        sectionId: section.id,
        content: 'secret'
      }))!

      assert.equal(await notesModel.getNote(fixtures.siteId, otherUserId, note.id), null)
      assert.equal(await notesModel.getNote(otherSiteId, fixtures.userId, note.id), null)
      assert.equal(await notesModel.getNote(fixtures.siteId, fixtures.userId, 'x'), null)
      assert.equal(
        await notesModel.updateNote(fixtures.siteId, otherUserId, note.id, { content: 'pwned' }),
        null
      )
      assert.equal(await notesModel.deleteNote(fixtures.siteId, otherUserId, note.id), false)
      assert.equal(await notesModel.deleteNote(otherSiteId, fixtures.userId, note.id), false)

      const fetched = await notesModel.getNote(fixtures.siteId, fixtures.userId, note.id)
      assert.equal(fetched?.content, 'secret')
      assert.equal(await notesModel.deleteNote(fixtures.siteId, fixtures.userId, note.id), true)
      assert.equal(await notesModel.getNote(fixtures.siteId, fixtures.userId, note.id), null)
    })

    test('update recomputes the excerpt, clears a blank title and bumps updatedAt', async () => {
      const section = await notesModel.createSection(fixtures.siteId, fixtures.userId, {
        title: 'Edit'
      })
      const note = (await notesModel.createNote(fixtures.siteId, fixtures.userId, {
        sectionId: section.id,
        title: 'Old',
        content: 'first'
      }))!

      const updated = await notesModel.updateNote(fixtures.siteId, fixtures.userId, note.id, {
        title: '   ',
        content: '**Second** version'
      })
      assert.equal(updated?.title, null)
      assert.equal(updated?.content, '**Second** version')
      assert.equal(updated?.excerpt, 'Second version')
      assert.ok(updated!.updatedAt.getTime() >= note.updatedAt.getTime())

      const titleOnly = await notesModel.updateNote(fixtures.siteId, fixtures.userId, note.id, {
        title: 'New'
      })
      assert.equal(titleOnly?.title, 'New')
      assert.equal(titleOnly?.content, '**Second** version', 'an omitted field is left alone')
    })

    test('update with expectedUpdatedAt saves only over that version, and otherwise hands back the stored note', async () => {
      const section = await notesModel.createSection(fixtures.siteId, fixtures.userId, {
        title: 'Tabs'
      })
      const note = (await notesModel.createNote(fixtures.siteId, fixtures.userId, {
        sectionId: section.id,
        content: 'v1'
      }))!
      const seen = note.updatedAt.toISOString()

      const first = await notesModel.updateNote(
        fixtures.siteId,
        fixtures.userId,
        note.id,
        { content: 'v2 from tab A' },
        { expectedUpdatedAt: seen }
      )
      assert.equal(first?.content, 'v2 from tab A')

      await assert.rejects(
        notesModel.updateNote(
          fixtures.siteId,
          fixtures.userId,
          note.id,
          { content: 'v2 from tab B' },
          { expectedUpdatedAt: seen }
        ),
        (err: any) =>
          err instanceof NoteConflictError &&
          err.statusCode === 409 &&
          err.current.content === 'v2 from tab A' &&
          err.current.updatedAt.getTime() === first!.updatedAt.getTime()
      )
      const stored = await notesModel.getNote(fixtures.siteId, fixtures.userId, note.id)
      assert.equal(stored?.content, 'v2 from tab A', 'a refused save writes nothing')

      const retried = await notesModel.updateNote(
        fixtures.siteId,
        fixtures.userId,
        note.id,
        { content: 'v3' },
        { expectedUpdatedAt: first!.updatedAt.toISOString() }
      )
      assert.equal(retried?.content, 'v3')
    })

    test('moving to an owned section appends there; a foreign section is refused and changes nothing', async () => {
      const userId = await createUser('notes-move@example.com')
      const from = await notesModel.createSection(fixtures.siteId, userId, { title: 'From' })
      const to = await notesModel.createSection(fixtures.siteId, userId, { title: 'To' })
      const foreign = await notesModel.createSection(fixtures.siteId, otherUserId, {
        title: 'Foreign'
      })
      const elsewhere = await notesModel.createSection(otherSiteId, userId, { title: 'Elsewhere' })
      await notesModel.createNote(fixtures.siteId, userId, { sectionId: to.id, content: 'there' })
      const note = (await notesModel.createNote(fixtures.siteId, userId, {
        sectionId: from.id,
        content: 'moving'
      }))!

      for (const target of [foreign.id, elsewhere.id, randomUUID(), 'bad']) {
        assert.equal(
          await notesModel.updateNote(fixtures.siteId, userId, note.id, {
            sectionId: target,
            content: 'changed'
          }),
          null
        )
      }
      const unchanged = await notesModel.getNote(fixtures.siteId, userId, note.id)
      assert.equal(unchanged?.sectionId, from.id)
      assert.equal(unchanged?.content, 'moving', 'a refused move writes no other field either')

      const moved = await notesModel.updateNote(fixtures.siteId, userId, note.id, {
        sectionId: to.id
      })
      assert.equal(moved?.sectionId, to.id)
      assert.equal(moved?.position, 1)
      assert.deepEqual(await notesModel.listNotes(fixtures.siteId, userId, from.id), [])
    })

    test('reorder refuses a mixed id list whole and never moves a note across sections', async () => {
      const userId = await createUser('notes-reorder@example.com')
      const section = await notesModel.createSection(fixtures.siteId, userId, { title: 'R' })
      const sibling = await notesModel.createSection(fixtures.siteId, userId, { title: 'Sib' })
      const foreignSection = await notesModel.createSection(fixtures.siteId, otherUserId, {
        title: 'F'
      })
      const mk = async (sectionId: string, owner = userId) =>
        (await notesModel.createNote(fixtures.siteId, owner, { sectionId }))!
      const [a, b, c] = [await mk(section.id), await mk(section.id), await mk(section.id)]
      const inSibling = await mk(sibling.id)
      const foreign = await mk(foreignSection.id, otherUserId)
      const order = async () =>
        (await notesModel.listNotes(fixtures.siteId, userId, section.id))!.map((n) => n.id)

      assert.equal(
        await notesModel.reorderNotes(fixtures.siteId, userId, section.id, [c.id, b.id, a.id]),
        true
      )
      assert.deepEqual(await order(), [c.id, b.id, a.id])

      assert.equal(
        await notesModel.reorderNotes(fixtures.siteId, userId, section.id, [a.id, foreign.id]),
        false
      )
      assert.equal(
        await notesModel.reorderNotes(fixtures.siteId, userId, section.id, [a.id, inSibling.id]),
        false
      )
      assert.equal(
        await notesModel.reorderNotes(fixtures.siteId, otherUserId, section.id, [a.id]),
        false
      )
      assert.equal(
        await notesModel.reorderNotes(fixtures.siteId, userId, foreignSection.id, [foreign.id]),
        false
      )
      assert.deepEqual(await order(), [c.id, b.id, a.id], 'a refused reorder changes nothing')
    })

    test('reads and deletes join a caller transaction', async () => {
      const section = await notesModel.createSection(fixtures.siteId, fixtures.userId, {
        title: 'Tx'
      })
      const note = (await notesModel.createNote(fixtures.siteId, fixtures.userId, {
        sectionId: section.id
      }))!
      await notesModel.addImage(fixtures.siteId, fixtures.userId, note.id, {
        fileName: 'a.png',
        mimeType: 'image/png',
        data: Buffer.from([1, 2, 3])
      })

      await assert.rejects(
        CARDINAL.db.transaction(async (tx) => {
          assert.ok(await notesModel.getNote(fixtures.siteId, fixtures.userId, note.id, { tx }))
          const images = await notesModel.listImages(fixtures.siteId, fixtures.userId, note.id, {
            tx
          })
          assert.equal(images?.length, 1)
          assert.ok(
            await notesModel.getImage(fixtures.siteId, fixtures.userId, note.id, images![0]!.id, {
              tx
            })
          )
          assert.equal(
            await notesModel.deleteNote(fixtures.siteId, fixtures.userId, note.id, { tx }),
            true
          )
          throw new Error('roll back')
        }),
        /roll back/
      )
      assert.ok(
        await notesModel.getNote(fixtures.siteId, fixtures.userId, note.id),
        'a rolled-back delete leaves the note in place'
      )
    })
  })

  describe('images', () => {
    test('belong to one note and are readable only by its owner on its site', async () => {
      const section = await notesModel.createSection(fixtures.siteId, fixtures.userId, {
        title: 'Img'
      })
      const note = (await notesModel.createNote(fixtures.siteId, fixtures.userId, {
        sectionId: section.id
      }))!
      const otherNote = (await notesModel.createNote(fixtures.siteId, fixtures.userId, {
        sectionId: section.id
      }))!
      const bytes = Buffer.from('fake-png-bytes')

      const image = await notesModel.addImage(fixtures.siteId, fixtures.userId, note.id, {
        fileName: 'shot.png',
        mimeType: 'image/png',
        data: bytes
      })
      assert.ok(image)
      assert.equal(image.fileSize, bytes.length)
      assert.equal(image.noteId, note.id)
      assert.ok(!('data' in image))

      assert.equal(
        await notesModel.addImage(fixtures.siteId, otherUserId, note.id, {
          fileName: 'x.png',
          mimeType: 'image/png',
          data: bytes
        }),
        null
      )

      const read = await notesModel.getImage(fixtures.siteId, fixtures.userId, note.id, image.id)
      assert.deepEqual(Buffer.from(read!.data), bytes)
      assert.equal(read!.mimeType, 'image/png')
      assert.equal(await notesModel.getImage(fixtures.siteId, otherUserId, note.id, image.id), null)
      assert.equal(await notesModel.getImage(otherSiteId, fixtures.userId, note.id, image.id), null)
      assert.equal(
        await notesModel.getImage(fixtures.siteId, fixtures.userId, otherNote.id, image.id),
        null,
        'an image is addressed through its own note only'
      )

      const listed = await notesModel.listImages(fixtures.siteId, fixtures.userId, note.id)
      assert.deepEqual(
        listed?.map((i) => i.id),
        [image.id]
      )
      assert.deepEqual(
        await notesModel.listImages(fixtures.siteId, fixtures.userId, otherNote.id),
        []
      )
      assert.equal(await notesModel.listImages(fixtures.siteId, otherUserId, note.id), null)
    })
  })

  describe('image quota', () => {
    test('refuses an image that would take one user past the quota on a site, and only there', async () => {
      const userId = await createUser('notes-quota@example.com')
      const section = await notesModel.createSection(fixtures.siteId, userId, { title: 'Full' })
      const note = (await notesModel.createNote(fixtures.siteId, userId, {
        sectionId: section.id
      }))!
      // -> The quota counts `fileSize`, so one row can stand for almost the whole allowance.
      await fixtures.db.insert(noteImagesTable).values({
        siteId: fixtures.siteId,
        userId,
        noteId: note.id,
        fileName: 'big.png',
        mimeType: 'image/png',
        fileSize: NOTE_IMAGE_QUOTA_BYTES - 10,
        data: Buffer.from([0])
      })
      const image = (bytes: number) => ({
        fileName: 'a.png',
        mimeType: 'image/png',
        data: Buffer.alloc(bytes, 1)
      })

      await assert.rejects(
        notesModel.addImage(fixtures.siteId, userId, note.id, image(11)),
        (err: any) => err.name === 'noteImageQuotaExceeded' && err.statusCode === 413
      )
      assert.equal(await fixtures.db.$count(noteImagesTable, eq(noteImagesTable.userId, userId)), 1)

      assert.ok(await notesModel.addImage(fixtures.siteId, userId, note.id, image(10)))

      const elsewhere = await notesModel.createSection(otherSiteId, userId, { title: 'Other' })
      const otherNote = (await notesModel.createNote(otherSiteId, userId, {
        sectionId: elsewhere.id
      }))!
      assert.ok(
        await notesModel.addImage(otherSiteId, userId, otherNote.id, image(11)),
        'the quota is per site'
      )
    })
  })

  describe('purgeOrphanImages', () => {
    test('deletes old images no note of their owner mentions, and keeps the rest', async () => {
      const userId = await createUser('notes-orphans@example.com')
      const section = await notesModel.createSection(fixtures.siteId, userId, { title: 'Pics' })
      const note = (await notesModel.createNote(fixtures.siteId, userId, {
        sectionId: section.id
      }))!
      const sibling = (await notesModel.createNote(fixtures.siteId, userId, {
        sectionId: section.id
      }))!
      const farSection = await notesModel.createSection(otherSiteId, userId, { title: 'Far' })
      const far = (await notesModel.createNote(otherSiteId, userId, {
        sectionId: farSection.id
      }))!
      const add = async () =>
        (await notesModel.addImage(fixtures.siteId, userId, note.id, {
          fileName: 'a.png',
          mimeType: 'image/png',
          data: Buffer.from([1, 2, 3])
        }))!.id
      const shown = await add()
      const removed = await add()
      const copied = await add()
      const copiedFar = await add()
      const recent = await add()
      const url = (imageId: string) =>
        `/_api/sites/${fixtures.siteId}/notes/${note.id}/images/${imageId}`

      await notesModel.updateNote(fixtures.siteId, userId, note.id, {
        content: `Kept ![a](${url(shown)})`
      })
      await notesModel.updateNote(fixtures.siteId, userId, sibling.id, {
        content: `Pasted here ![a](${url(copied).toUpperCase()})`
      })
      await notesModel.updateNote(otherSiteId, userId, far.id, {
        content: `On another site ![a](${url(copiedFar)})`
      })

      const strangerId = await createUser('notes-orphans-stranger@example.com')
      const strangerSection = await notesModel.createSection(fixtures.siteId, strangerId, {
        title: 'Theirs'
      })
      const strangerNote = (await notesModel.createNote(fixtures.siteId, strangerId, {
        sectionId: strangerSection.id,
        content: `Mentions someone else's image ${removed}`
      }))!
      const strangerOrphan = (await notesModel.addImage(
        fixtures.siteId,
        strangerId,
        strangerNote.id,
        {
          fileName: 'b.png',
          mimeType: 'image/png',
          data: Buffer.from([4])
        }
      ))!.id

      await fixtures.db
        .update(noteImagesTable)
        .set({ createdAt: sql`now() - interval '25 hours'` })
        .where(inArray(noteImagesTable.id, [shown, removed, copied, copiedFar, strangerOrphan]))

      assert.equal(await notesModel.purgeOrphanImages(), 2)

      const left = await fixtures.db
        .select({ id: noteImagesTable.id })
        .from(noteImagesTable)
        .where(
          inArray(noteImagesTable.id, [shown, removed, copied, copiedFar, recent, strangerOrphan])
        )
      assert.deepEqual(
        new Set(left.map((row) => row.id)),
        new Set([shown, copied, copiedFar, recent]),
        "an image another user's note names is still an orphan; a recent one waits out the grace"
      )
      assert.equal(await notesModel.purgeOrphanImages(), 0)
    })
  })

  describe('cascades', () => {
    test('deleting a section deletes its notes and their images', async () => {
      const section = await notesModel.createSection(fixtures.siteId, fixtures.userId, {
        title: 'Doomed'
      })
      const note = (await notesModel.createNote(fixtures.siteId, fixtures.userId, {
        sectionId: section.id
      }))!
      await notesModel.addImage(fixtures.siteId, fixtures.userId, note.id, {
        fileName: 'a.png',
        mimeType: 'image/png',
        data: Buffer.from([0])
      })

      assert.equal(
        await notesModel.deleteSection(fixtures.siteId, fixtures.userId, section.id),
        true
      )
      assert.equal(await fixtures.db.$count(notesTable, eq(notesTable.id, note.id)), 0)
      assert.equal(
        await fixtures.db.$count(noteImagesTable, eq(noteImagesTable.noteId, note.id)),
        0
      )
    })

    test('a user with notes can be deleted, and their sections, notes and images go with them', async () => {
      const userId = await createUser('notes-deleted@example.com')
      const section = await notesModel.createSection(fixtures.siteId, userId, { title: 'Gone' })
      const note = (await notesModel.createNote(fixtures.siteId, userId, {
        sectionId: section.id,
        content: 'bye'
      }))!
      await notesModel.addImage(fixtures.siteId, userId, note.id, {
        fileName: 'a.png',
        mimeType: 'image/png',
        data: Buffer.from([0])
      })
      const keptSection = await notesModel.createSection(fixtures.siteId, otherUserId, {
        title: 'Kept'
      })

      assert.equal(await CARDINAL.models.users.deleteUser(userId), true)

      assert.equal(
        await fixtures.db.$count(noteSectionsTable, eq(noteSectionsTable.userId, userId)),
        0
      )
      assert.equal(await fixtures.db.$count(notesTable, eq(notesTable.userId, userId)), 0)
      assert.equal(await fixtures.db.$count(noteImagesTable, eq(noteImagesTable.userId, userId)), 0)
      assert.equal(
        await fixtures.db.$count(noteSectionsTable, eq(noteSectionsTable.id, keptSection.id)),
        1,
        "another user's notes are untouched"
      )
    })

    test('deleting a site deletes the notes held on it and leaves other sites alone', async () => {
      const siteId = await createSite('notes-doomed.localhost')
      const section = await notesModel.createSection(siteId, fixtures.userId, { title: 'Site' })
      const note = (await notesModel.createNote(siteId, fixtures.userId, {
        sectionId: section.id
      }))!
      await notesModel.addImage(siteId, fixtures.userId, note.id, {
        fileName: 'a.png',
        mimeType: 'image/png',
        data: Buffer.from([0])
      })
      const survivor = await notesModel.createSection(fixtures.siteId, fixtures.userId, {
        title: 'Survivor'
      })

      assert.equal(await CARDINAL.models.sites.deleteSite(siteId), true)

      assert.equal(
        await fixtures.db.$count(noteSectionsTable, eq(noteSectionsTable.siteId, siteId)),
        0
      )
      assert.equal(await fixtures.db.$count(notesTable, eq(notesTable.siteId, siteId)), 0)
      assert.equal(await fixtures.db.$count(noteImagesTable, eq(noteImagesTable.siteId, siteId)), 0)
      assert.equal(
        await fixtures.db.$count(noteSectionsTable, eq(noteSectionsTable.id, survivor.id)),
        1
      )
    })
  })
})
