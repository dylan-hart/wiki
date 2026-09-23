import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import notesRoutes, { noteImageUrl } from './notes.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import { CustomError } from '../helpers/common.ts'
import { WHITEBOARD_MAX_BLOCK_BYTES } from '../helpers/whiteboardLimits.ts'

const SITE_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = '22222222-2222-4222-8222-222222222222'
const SECTION_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_SECTION_ID = '44444444-4444-4444-8444-444444444444'
const NOTE_ID = '55555555-5555-4555-8555-555555555555'
const NOTE_2_ID = '66666666-6666-4666-8666-666666666666'
const FOREIGN_NOTE_ID = '77777777-7777-4777-8777-777777777777'
const IMAGE_ID = '88888888-8888-4888-8888-888888888888'
const MOVE_TARGET_ID = '99999999-9999-4999-8999-999999999999'

const BASE = `/sites/${SITE_ID}/notes`
const MODEL_METHODS = [
  'listSections',
  'createSection',
  'updateSection',
  'deleteSection',
  'reorderSections',
  'listNotes',
  'getNote',
  'createNote',
  'updateNote',
  'deleteNote',
  'reorderNotes',
  'addImage',
  'getImage'
]
const NOW = new Date('2026-09-23T10:00:00Z')

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 1)
])

function section(id: string, position = 0) {
  return {
    id,
    siteId: SITE_ID,
    userId: OWNER_ID,
    title: `Section ${position}`,
    position,
    createdAt: NOW,
    updatedAt: NOW
  }
}

function note(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    siteId: SITE_ID,
    userId: OWNER_ID,
    sectionId: SECTION_ID,
    title: null,
    excerpt: 'First line',
    content: 'First line\n\nMore',
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra
  }
}

async function multipart(
  content: Buffer | string,
  fileName = 'shot.png',
  type = 'image/png'
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData()
  const part = typeof content === 'string' ? content : new Uint8Array(content)
  form.append('file', new Blob([part], { type }), fileName)
  const res = new Response(form)
  return {
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { 'content-type': res.headers.get('content-type')! }
  }
}

describe('notes routes', () => {
  let app: FastifyInstance
  let session: any
  let model: Record<string, ReturnType<typeof mock.fn>>
  let searchRows: any[]
  let executeCalls: number
  let consumeUpload: ReturnType<typeof mock.fn>

  function setNotesFlag(value: boolean | undefined) {
    const features = CARDINAL.sites[SITE_ID]!.config.features as Record<string, unknown>
    if (value === undefined) {
      delete features.notes
    } else {
      features.notes = value
    }
  }

  function modelCalls(): number {
    return Object.values(model).reduce((n, fn) => n + fn.mock.calls.length, 0) + executeCalls
  }

  function writeCalls(): string[] {
    return Object.entries(model)
      .filter(([name, fn]) => !/^(list|get)/.test(name) && fn.mock.calls.length > 0)
      .map(([name]) => name)
  }

  function chain(rows: () => unknown[]): any {
    const link = (): any => {
      const node: any = Promise.resolve().then(() => {
        executeCalls++
        return rows()
      })
      for (const method of ['from', 'where', 'orderBy', 'limit']) {
        node[method] = link
      }
      return node
    }
    return link()
  }

  before(async () => {
    app = await buildTestApp({
      routes: notesRoutes,
      ajv: true,
      session: () => session,
      wiki: {
        sites: {
          [SITE_ID]: { id: SITE_ID, isEnabled: true, config: { features: { notes: true } } }
        },
        config: { security: {} },
        db: { select: () => chain(() => searchRows) },
        models: {
          groups: { groupIdsForRequest: () => [] },
          rateLimits: { consume: (...args: any[]) => consumeUpload(...args) },
          notes: Object.fromEntries(
            MODEL_METHODS.map((name) => [name, (...args: any[]) => model[name]!(...args)])
          )
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    session = { authenticated: true, user: { id: OWNER_ID }, permissions: [] }
    setNotesFlag(true)
    searchRows = []
    executeCalls = 0
    consumeUpload = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    model = {
      listSections: mock.fn(async () => [section(SECTION_ID, 0), section(OTHER_SECTION_ID, 1)]),
      createSection: mock.fn(async (_s: string, _u: string, { title }: any) => ({
        ...section(MOVE_TARGET_ID, 2),
        title
      })),
      updateSection: mock.fn(async (_s: string, _u: string, id: string, { title }: any) =>
        id === SECTION_ID ? { ...section(SECTION_ID), title } : null
      ),
      deleteSection: mock.fn(async (_s: string, _u: string, id: string) => id === SECTION_ID),
      reorderSections: mock.fn(async () => true),
      listNotes: mock.fn(async (_s: string, _u: string, sectionId: string) =>
        sectionId === SECTION_ID
          ? [note(NOTE_ID), note(NOTE_2_ID, { position: 1, title: 'Two' })].map(
              ({ content: _c, ...rest }) => rest
            )
          : []
      ),
      getNote: mock.fn(async (_s: string, _u: string, id: string) =>
        id === NOTE_ID ? note(NOTE_ID) : null
      ),
      createNote: mock.fn(async (_s: string, _u: string, input: any) =>
        note(NOTE_ID, { ...input, content: input.content ?? '' })
      ),
      updateNote: mock.fn(async (_s: string, _u: string, id: string) =>
        id === NOTE_ID ? note(NOTE_ID, { updatedAt: new Date('2026-09-23T11:00:00Z') }) : null
      ),
      deleteNote: mock.fn(async (_s: string, _u: string, id: string) => id === NOTE_ID),
      reorderNotes: mock.fn(async () => true),
      addImage: mock.fn(async () => ({ id: IMAGE_ID })),
      getImage: mock.fn(async (_s: string, _u: string, noteId: string, imageId: string) =>
        noteId === NOTE_ID && imageId === IMAGE_ID
          ? { id: IMAGE_ID, noteId, mimeType: 'image/png', data: PNG, fileName: 'shot.png' }
          : null
      )
    }
  })

  const ROUTES: {
    name: string
    method: 'GET' | 'POST' | 'PUT' | 'DELETE'
    url: string
    body?: any
  }[] = [
    { name: 'list sections', method: 'GET', url: `${BASE}/sections` },
    { name: 'create section', method: 'POST', url: `${BASE}/sections`, body: { title: 'A' } },
    {
      name: 'rename section',
      method: 'PUT',
      url: `${BASE}/sections/${SECTION_ID}`,
      body: { title: 'B' }
    },
    { name: 'delete section', method: 'DELETE', url: `${BASE}/sections/${SECTION_ID}` },
    {
      name: 'reorder sections',
      method: 'PUT',
      url: `${BASE}/sections/order`,
      body: { ids: [SECTION_ID] }
    },
    { name: 'list notes', method: 'GET', url: `${BASE}?sectionId=${SECTION_ID}` },
    { name: 'get note', method: 'GET', url: `${BASE}/${NOTE_ID}` },
    { name: 'create note', method: 'POST', url: BASE, body: { sectionId: SECTION_ID } },
    { name: 'update note', method: 'PUT', url: `${BASE}/${NOTE_ID}`, body: { content: 'x' } },
    { name: 'delete note', method: 'DELETE', url: `${BASE}/${NOTE_ID}` },
    {
      name: 'reorder notes',
      method: 'PUT',
      url: `${BASE}/order`,
      body: { sectionId: SECTION_ID, ids: [NOTE_ID] }
    },
    { name: 'search', method: 'GET', url: `${BASE}/search?q=hello` },
    { name: 'get image', method: 'GET', url: `${BASE}/${NOTE_ID}/images/${IMAGE_ID}` },
    { name: 'upload image', method: 'POST', url: `${BASE}/${NOTE_ID}/images` }
  ]

  async function send(route: (typeof ROUTES)[number]) {
    if (route.name === 'upload image') {
      const { payload, headers } = await multipart(PNG)
      return app.inject({ method: route.method, url: route.url, payload, headers })
    }
    return app.inject({ method: route.method, url: route.url, payload: route.body })
  }

  for (const route of ROUTES) {
    test(`${route.name} answers 401 for a guest and never touches the model`, async () => {
      session = { authenticated: false }

      const res = await send(route)

      assert.equal(res.statusCode, 401)
      assert.equal(modelCalls(), 0)
    })

    test(`${route.name} answers 403 notesDisabled with the flag off`, async () => {
      setNotesFlag(false)

      const res = await send(route)

      assert.equal(res.statusCode, 403)
      assert.equal(res.json().error, 'notesDisabled')
      assert.equal(modelCalls(), 0)
    })

    test(`${route.name} is allowed on a site without the flag set`, async () => {
      setNotesFlag(undefined)

      const res = await send(route)

      assert.ok(res.statusCode < 400, `${res.statusCode}: ${res.body}`)
    })
  }

  test('every model call is scoped to the site and the session user', async () => {
    for (const route of ROUTES) {
      await send(route)
    }

    const called = Object.entries(model).filter(([, fn]) => fn.mock.calls.length > 0)
    assert.ok(called.length >= 12, `only ${called.map(([n]) => n).join(', ')} were called`)
    for (const [name, fn] of called) {
      for (const call of fn.mock.calls) {
        assert.equal(call.arguments[0], SITE_ID, name)
        assert.equal(call.arguments[1], OWNER_ID, name)
      }
    }
  })

  test('a personal access token acts as its own user', async () => {
    session = undefined
    const tokenApp = await buildTestApp({
      routes: notesRoutes,
      ajv: true,
      session: (req) => {
        ;(req as any).apiKey = { userId: MOVE_TARGET_ID, permissions: [], groupIds: [] }
        return undefined
      }
    })
    try {
      const res = await tokenApp.inject({ method: 'GET', url: `${BASE}/sections` })

      assert.equal(res.statusCode, 200)
      assert.equal(model.listSections!.mock.calls[0]?.arguments[1], MOVE_TARGET_ID)
    } finally {
      await tokenApp.close()
    }
  })

  describe('sections', () => {
    test('lists the caller’s sections', async () => {
      const res = await app.inject({ method: 'GET', url: `${BASE}/sections` })

      assert.equal(res.statusCode, 200)
      const body = res.json()
      assert.deepEqual(
        body.sections.map((s: any) => s.id),
        [SECTION_ID, OTHER_SECTION_ID]
      )
      assert.equal(body.sections[0].userId, undefined)
    })

    test('creates a section with a trimmed title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `${BASE}/sections`,
        payload: { title: '  Ideas  ' }
      })

      assert.equal(res.statusCode, 200)
      assert.equal(res.json().title, 'Ideas')
      assert.deepEqual(model.createSection!.mock.calls[0]?.arguments.slice(2), [{ title: 'Ideas' }])
    })

    test('refuses a blank section title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `${BASE}/sections`,
        payload: { title: '   ' }
      })

      assert.equal(res.statusCode, 400)
      assert.equal(model.createSection!.mock.calls.length, 0)
    })

    test('renaming or deleting another user’s section answers 404', async () => {
      const rename = await app.inject({
        method: 'PUT',
        url: `${BASE}/sections/${MOVE_TARGET_ID}`,
        payload: { title: 'Mine now' }
      })
      const remove = await app.inject({
        method: 'DELETE',
        url: `${BASE}/sections/${MOVE_TARGET_ID}`
      })

      assert.equal(rename.statusCode, 404)
      assert.equal(rename.json().message, 'This section does not exist.')
      assert.equal(remove.statusCode, 404)
    })

    test('reorders the caller’s own sections', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `${BASE}/sections/order`,
        payload: { ids: [OTHER_SECTION_ID, SECTION_ID] }
      })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(model.reorderSections!.mock.calls[0]?.arguments, [
        SITE_ID,
        OWNER_ID,
        [OTHER_SECTION_ID, SECTION_ID]
      ])
    })

    test('a reorder naming another user’s section is refused whole with 404', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `${BASE}/sections/order`,
        payload: { ids: [SECTION_ID, MOVE_TARGET_ID, OTHER_SECTION_ID] }
      })

      assert.equal(res.statusCode, 404)
      assert.deepEqual(writeCalls(), [])
    })

    test('a reorder the model refuses answers 404', async () => {
      model.reorderSections = mock.fn(async () => false)

      const res = await app.inject({
        method: 'PUT',
        url: `${BASE}/sections/order`,
        payload: { ids: [SECTION_ID] }
      })

      assert.equal(res.statusCode, 404)
    })

    test('a reorder with a repeated id is refused as invalid', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `${BASE}/sections/order`,
        payload: { ids: [SECTION_ID, SECTION_ID] }
      })

      assert.equal(res.statusCode, 400)
      assert.deepEqual(writeCalls(), [])
    })
  })

  describe('notes', () => {
    test('lists a section’s notes without their content', async () => {
      const res = await app.inject({ method: 'GET', url: `${BASE}?sectionId=${SECTION_ID}` })

      assert.equal(res.statusCode, 200)
      const [first, second] = res.json().notes
      assert.equal(first.id, NOTE_ID)
      assert.equal(first.title, null)
      assert.equal(first.excerpt, 'First line')
      assert.equal(first.content, undefined)
      assert.equal(second.title, 'Two')
    })

    test('listing another user’s section answers 404', async () => {
      const res = await app.inject({ method: 'GET', url: `${BASE}?sectionId=${MOVE_TARGET_ID}` })

      assert.equal(res.statusCode, 404)
      assert.equal(model.listNotes!.mock.calls.length, 0)
    })

    test('gets a note with its content', async () => {
      const res = await app.inject({ method: 'GET', url: `${BASE}/${NOTE_ID}` })

      assert.equal(res.statusCode, 200)
      assert.equal(res.json().content, 'First line\n\nMore')
      assert.equal(res.json().userId, undefined)
    })

    test('another user’s note answers 404 on every note route', async () => {
      const url = `${BASE}/${FOREIGN_NOTE_ID}`
      const responses = await Promise.all([
        app.inject({ method: 'GET', url }),
        app.inject({ method: 'PUT', url, payload: { content: 'overwrite' } }),
        app.inject({ method: 'DELETE', url }),
        app.inject({ method: 'GET', url: `${url}/images/${IMAGE_ID}` }),
        multipart(PNG).then(({ payload, headers }) =>
          app.inject({ method: 'POST', url: `${url}/images`, payload, headers })
        )
      ])

      for (const res of responses) {
        assert.equal(res.statusCode, 404, res.body)
      }
      assert.equal(responses[0]!.json().message, 'This note does not exist.')
      assert.equal(model.addImage!.mock.calls.length, 0)
    })

    test('creates a note in the caller’s section, storing an empty title as none', async () => {
      const res = await app.inject({
        method: 'POST',
        url: BASE,
        payload: { sectionId: SECTION_ID, title: '  ', content: 'Hello' }
      })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(model.createNote!.mock.calls[0]?.arguments.slice(2), [
        { sectionId: SECTION_ID, title: null, content: 'Hello' }
      ])
    })

    test('creating a note in another user’s section answers 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: BASE,
        payload: { sectionId: MOVE_TARGET_ID }
      })

      assert.equal(res.statusCode, 404)
      assert.equal(model.createNote!.mock.calls.length, 0)
    })

    test('update saves only the fields sent and answers updatedAt', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `${BASE}/${NOTE_ID}`,
        payload: { content: 'New body' }
      })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), { updatedAt: '2026-09-23T11:00:00.000Z' })
      assert.deepEqual(model.updateNote!.mock.calls[0]?.arguments.slice(2), [
        NOTE_ID,
        { content: 'New body' }
      ])
    })

    test('update clears a title sent as null or blank', async () => {
      await app.inject({ method: 'PUT', url: `${BASE}/${NOTE_ID}`, payload: { title: null } })
      await app.inject({ method: 'PUT', url: `${BASE}/${NOTE_ID}`, payload: { title: ' ' } })

      assert.deepEqual(
        model.updateNote!.mock.calls.map((c) => c.arguments[3]),
        [{ title: null }, { title: null }]
      )
    })

    test('moves a note to another of the caller’s sections', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `${BASE}/${NOTE_ID}`,
        payload: { sectionId: OTHER_SECTION_ID }
      })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(model.updateNote!.mock.calls[0]?.arguments[3], {
        sectionId: OTHER_SECTION_ID
      })
    })

    test('moving a note into another user’s section answers 404 and writes nothing', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `${BASE}/${NOTE_ID}`,
        payload: { sectionId: MOVE_TARGET_ID, content: 'x' }
      })

      assert.equal(res.statusCode, 404)
      assert.equal(res.json().message, 'This section does not exist.')
      assert.deepEqual(writeCalls(), [])
    })

    test('an unknown field is dropped, never passed to the model', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `${BASE}/${NOTE_ID}`,
        payload: { userId: MOVE_TARGET_ID, content: 'x' }
      })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(model.updateNote!.mock.calls[0]?.arguments[3], { content: 'x' })
    })

    test('a whiteboard over the cap is refused on create and update', async () => {
      const content = `::block-whiteboard\n\`\`\`whiteboard\n${'x'.repeat(WHITEBOARD_MAX_BLOCK_BYTES + 1)}\n\`\`\`\n::`

      const created = await app.inject({
        method: 'POST',
        url: BASE,
        payload: { sectionId: SECTION_ID, content }
      })
      const updated = await app.inject({
        method: 'PUT',
        url: `${BASE}/${NOTE_ID}`,
        payload: { content }
      })

      for (const res of [created, updated]) {
        assert.equal(res.statusCode, 400)
        assert.equal(res.json().error, 'noteWhiteboardTooLarge')
      }
      assert.deepEqual(writeCalls(), [])
    })

    test('reorders the notes of the caller’s section', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `${BASE}/order`,
        payload: { sectionId: SECTION_ID, ids: [NOTE_2_ID, NOTE_ID] }
      })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(model.reorderNotes!.mock.calls[0]?.arguments, [
        SITE_ID,
        OWNER_ID,
        SECTION_ID,
        [NOTE_2_ID, NOTE_ID]
      ])
    })

    test('a note reorder naming another user’s note is refused whole with 404', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `${BASE}/order`,
        payload: { sectionId: SECTION_ID, ids: [NOTE_ID, FOREIGN_NOTE_ID, NOTE_2_ID] }
      })

      assert.equal(res.statusCode, 404)
      assert.deepEqual(writeCalls(), [])
    })

    test('a note reorder in another user’s section answers 404', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `${BASE}/order`,
        payload: { sectionId: MOVE_TARGET_ID, ids: [NOTE_ID] }
      })

      assert.equal(res.statusCode, 404)
      assert.deepEqual(writeCalls(), [])
    })

    test('a note reorder naming a note from another section answers 404', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `${BASE}/order`,
        payload: { sectionId: OTHER_SECTION_ID, ids: [NOTE_ID] }
      })

      assert.equal(res.statusCode, 404)
      assert.deepEqual(writeCalls(), [])
    })

    test('a non-uuid note id is refused before the model is asked', async () => {
      const res = await app.inject({ method: 'GET', url: `${BASE}/not-a-uuid` })

      assert.equal(res.statusCode, 400)
      assert.equal(modelCalls(), 0)
    })
  })

  describe('images', () => {
    test('stores an image and answers the fixed owner-only URL', async () => {
      const { payload, headers } = await multipart(PNG, '../../dir/evil name.png', 'text/plain')

      const res = await app.inject({
        method: 'POST',
        url: `${BASE}/${NOTE_ID}/images`,
        payload,
        headers
      })

      assert.equal(res.statusCode, 200, res.body)
      assert.deepEqual(res.json(), {
        id: IMAGE_ID,
        url: `/_api/sites/${SITE_ID}/notes/${NOTE_ID}/images/${IMAGE_ID}`
      })
      const [, , noteId, input] = model.addImage!.mock.calls[0]!.arguments as any[]
      assert.equal(noteId, NOTE_ID)
      assert.equal(input.mimeType, 'image/png')
      assert.equal(input.fileName, 'evil name.png')
      assert.ok(Buffer.from(input.data).equals(PNG))
    })

    test('an upload spends the caller’s upload budget, and a spent budget answers 429 first', async () => {
      const { payload, headers } = await multipart(PNG)
      const upload = () =>
        app.inject({ method: 'POST', url: `${BASE}/${NOTE_ID}/images`, payload, headers })

      assert.equal((await upload()).statusCode, 200)
      assert.equal(consumeUpload.mock.calls[0]?.arguments[0], `upload:${OWNER_ID}`)

      // -> Another user, so the ban this memoizes does not reach the other tests.
      session = { authenticated: true, user: { id: MOVE_TARGET_ID }, permissions: [] }
      consumeUpload.mock.mockImplementation(async () => ({
        allowed: false,
        hits: 21,
        retryAfter: 60
      }))
      const refused = await upload()

      assert.equal(refused.statusCode, 429)
      assert.equal(refused.headers['retry-after'], '60')
      assert.equal(model.addImage!.mock.calls.length, 1)
    })

    test('an upload past the image quota answers 413 with its own error code', async () => {
      model.addImage = mock.fn(async () => {
        throw new CustomError('noteImageQuotaExceeded', 'Over the note image quota.', 413)
      })
      const { payload, headers } = await multipart(PNG)

      const res = await app.inject({
        method: 'POST',
        url: `${BASE}/${NOTE_ID}/images`,
        payload,
        headers
      })

      assert.equal(res.statusCode, 413)
      assert.equal(res.json().error, 'noteImageQuotaExceeded')
      assert.equal(res.json().message, 'Over the note image quota.')
    })

    test('noteImageUrl is the pinned format', () => {
      assert.equal(noteImageUrl('s', 'n', 'i'), '/_api/sites/s/notes/n/images/i')
    })

    test('refuses a file that is not a raster image, SVG included', async () => {
      for (const [content, type] of [
        [
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
          'image/svg+xml'
        ],
        ['just some text that is long enough', 'image/png']
      ]) {
        const { payload, headers } = await multipart(content!, 'x.png', type)
        const res = await app.inject({
          method: 'POST',
          url: `${BASE}/${NOTE_ID}/images`,
          payload,
          headers
        })

        assert.equal(res.statusCode, 400)
      }
      assert.equal(model.addImage!.mock.calls.length, 0)
    })

    test('refuses an image over the upload size limit with 413', async () => {
      const previous = CARDINAL.config.security
      CARDINAL.config.security = { uploadMaxFileSize: 64 }
      const smallApp = await buildTestApp({
        routes: notesRoutes,
        ajv: true,
        session: () => session
      })
      try {
        const { payload, headers } = await multipart(Buffer.concat([PNG, Buffer.alloc(1024)]))
        const res = await smallApp.inject({
          method: 'POST',
          url: `${BASE}/${NOTE_ID}/images`,
          payload,
          headers
        })

        assert.equal(res.statusCode, 413)
        assert.equal(model.addImage!.mock.calls.length, 0)
      } finally {
        await smallApp.close()
        CARDINAL.config.security = previous
      }
    })

    test('refuses a body that is not multipart', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `${BASE}/${NOTE_ID}/images`,
        payload: { file: 'x' }
      })

      assert.equal(res.statusCode, 400)
      assert.equal(model.addImage!.mock.calls.length, 0)
    })

    test('serves the image privately, with nosniff', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${BASE}/${NOTE_ID}/images/${IMAGE_ID}`
      })

      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['content-type'], 'image/png')
      assert.match(String(res.headers['cache-control']), /^private\b/)
      assert.equal(res.headers['x-content-type-options'], 'nosniff')
      assert.ok(res.rawPayload.equals(PNG))
    })

    test('answers 304 for a cached copy', async () => {
      const first = await app.inject({
        method: 'GET',
        url: `${BASE}/${NOTE_ID}/images/${IMAGE_ID}`
      })
      const second = await app.inject({
        method: 'GET',
        url: `${BASE}/${NOTE_ID}/images/${IMAGE_ID}`,
        headers: { 'if-none-match': String(first.headers.etag) }
      })

      assert.equal(second.statusCode, 304)
    })

    test('an image of another note answers 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${BASE}/${NOTE_2_ID}/images/${IMAGE_ID}`
      })

      assert.equal(res.statusCode, 404)
      assert.equal(res.json().message, 'This image does not exist.')
    })
  })

  describe('search', () => {
    test('answers the caller’s matches with their excerpt', async () => {
      searchRows = [
        { id: NOTE_ID, sectionId: SECTION_ID, title: null, excerpt: 'Groceries' },
        { id: NOTE_2_ID, sectionId: OTHER_SECTION_ID, title: 'Plan', excerpt: 'eggs' }
      ]

      const res = await app.inject({ method: 'GET', url: `${BASE}/search?q=milk` })

      assert.equal(res.statusCode, 200)
      const { results } = res.json()
      assert.deepEqual(
        results.map((r: any) => [r.id, r.sectionId, r.title]),
        [
          [NOTE_ID, SECTION_ID, null],
          [NOTE_2_ID, OTHER_SECTION_ID, 'Plan']
        ]
      )
      assert.equal(results[0].excerpt, 'Groceries')
      assert.equal(results[0].content, undefined)
    })

    test('an empty query answers no results without querying', async () => {
      const res = await app.inject({ method: 'GET', url: `${BASE}/search?q=%20` })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), { results: [] })
      assert.equal(executeCalls, 0)
    })

    test('/search is not taken for a note id', async () => {
      await app.inject({ method: 'GET', url: `${BASE}/search?q=x` })

      assert.equal(model.getNote!.mock.calls.length, 0)
    })
  })
})
