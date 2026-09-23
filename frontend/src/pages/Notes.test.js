import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  confirm: vi.fn(),
  dialog: vi.fn()
}))
vi.mock('@/composables/notify', () => ({ notify: vi.fn() }))

const { confirm, dialog } = await import('@/composables/dialog')
const { notify } = await import('@/composables/notify')
const Notes = (await import('./Notes.vue')).default

import { mountWithApp } from '../../test/mount.js'
import { createTestRouter } from '../../test/router.js'

const EditorStub = defineComponent({
  name: 'EditorWysiwyg',
  props: {
    content: { type: String, default: null },
    uploadFile: { type: Function, default: null },
    autofocus: { type: Boolean, default: false }
  },
  emits: ['update:content'],
  setup(props) {
    return () =>
      h('div', {
        class: 'editor-stub',
        'data-content': props.content,
        'data-autofocus': String(props.autofocus)
      })
  }
})

const BASE = 'sites/site-1/notes'

function fakeServer({ sections = [], notes = [] } = {}) {
  const db = {
    sections: sections.map((s) => ({ ...s })),
    notes: notes.map((n) => ({ ...n })),
    pages: [],
    promoted: [],
    seq: 100
  }
  const reply = (payload) => ({ json: () => Promise.resolve(payload) })
  const listRow = ({ content: _content, ...row }) => row

  API_CLIENT.get.mockImplementation((url, opts) => {
    if (url === `${BASE}/sections`) {
      return reply({ sections: db.sections.map((s) => ({ ...s })) })
    }
    if (url === BASE) {
      const sectionId = opts?.searchParams?.sectionId
      return reply({ notes: db.notes.filter((n) => n.sectionId === sectionId).map(listRow) })
    }
    const id = url.slice(BASE.length + 1)
    return reply({ note: db.notes.find((n) => n.id === id) ?? null })
  })
  API_CLIENT.post.mockImplementation((url, opts) => {
    if (url === `${BASE}/sections`) {
      const section = { id: `s${++db.seq}`, title: opts.json.title }
      db.sections.push(section)
      return reply({ section })
    }
    if (url === BASE) {
      const note = {
        id: `n${++db.seq}`,
        sectionId: opts.json.sectionId,
        title: null,
        content: '',
        excerpt: ''
      }
      db.notes.push(note)
      return reply({ note })
    }
    const noteId = url.slice(BASE.length + 1).split('/')[0]
    if (url.endsWith('/promote')) {
      return { json: () => promoteNote(db, noteId, opts.json) }
    }
    return reply({ id: 'img1', url: `/_api/${BASE}/${noteId}/images/img1` })
  })
  API_CLIENT.put.mockImplementation((url, opts) => {
    const id = url.slice(BASE.length + 1)
    const note = db.notes.find((n) => n.id === id)
    if (!note) {
      return reply({ updatedAt: 'now' })
    }
    Object.assign(note, opts.json)
    note.updatedAt = `2026-09-23T10:00:00.${String(++db.seq).padStart(3, '0')}Z`
    return reply({ updatedAt: note.updatedAt })
  })
  API_CLIENT.delete.mockImplementation((url) => {
    const id = url.slice(BASE.length + 1)
    db.notes = db.notes.filter((n) => n.id !== id)
    return reply({ ok: true })
  })
  return db
}

function refusal(statusCode, error, message) {
  return Object.assign(new Error(`Request failed with status code ${statusCode}`), {
    data: { ok: false, statusCode, error, message }
  })
}

async function promoteNote(db, noteId, body) {
  const note = db.notes.find((n) => n.id === noteId)
  if (body.noteUpdatedAt !== note.updatedAt) {
    throw refusal(409, 'noteChanged', 'The note changed while it was being promoted. Try again.')
  }
  if (db.pages.includes(body.path)) {
    throw refusal(409, 'pageDuplicatePath', 'A page already exists at this path.')
  }
  db.pages.push(body.path)
  db.promoted.push({ noteId, content: note.content, ...body })
  db.notes = db.notes.filter((n) => n.id !== noteId)
  return { ok: true, pageId: 'p1', path: body.path, locale: 'en', images: 0 }
}

function putCalls() {
  return API_CLIENT.put.mock.calls.map(([url, opts]) => [url, opts?.json])
}

let wrapper = null

async function mountNotes({ path = '/_notes', authenticated = true, features = {} } = {}) {
  const router = await createTestRouter(['/_notes', '/login', '/elsewhere', '/:path(.*)*'], path)
  const mounted = mountWithApp(Notes, {
    router,
    attachTo: document.body,
    stores: {
      site: (store) => {
        store.id = 'site-1'
        Object.assign(store.features, features)
      },
      user: { authenticated, id: 'u1' }
    },
    global: { stubs: { EditorWysiwyg: EditorStub } }
  })
  wrapper = mounted.wrapper
  await flushPromises()
  return { ...mounted, router }
}

function editor() {
  return wrapper.findComponent({ name: 'EditorWysiwyg' })
}

function listLabels() {
  return wrapper.findAll('.notes-list-label').map((el) => el.text())
}

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    return
  }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  confirm.mockReset()
  dialog.mockReset()
  notify.mockReset()
})

describe('Notes screen', () => {
  it('asks a guest to sign in and calls no notes API', async () => {
    await mountNotes({ authenticated: false })
    expect(wrapper.find('.notes-page-guest').text()).toContain('notes.signInRequired')
    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('says notes are off when the site flag is false, and calls no notes API', async () => {
    fakeServer()
    await mountNotes({ features: { notes: false } })
    expect(wrapper.find('.notes-page-disabled').text()).toContain('notes.disabled')
    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('opens the remembered section, lists its notes and opens the first one', async () => {
    fakeServer({
      sections: [
        { id: 's1', title: 'Work' },
        { id: 's2', title: 'Home' }
      ],
      notes: [
        { id: 'n1', sectionId: 's1', title: 'Standup', content: 'x', excerpt: 'x' },
        { id: 'n2', sectionId: 's2', title: null, content: 'Buy milk', excerpt: 'Buy milk' },
        { id: 'n3', sectionId: 's2', title: 'Plumber', content: 'call', excerpt: 'call' }
      ]
    })
    localStorage.setItem('notes.lastSection.site-1', 's2')
    await mountNotes()

    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe('Home')
    expect(listLabels()).toEqual(['Buy milk', 'Plumber'])
    expect(editor().props('content')).toBe('Buy milk')
    expect(wrapper.find('input[aria-label="notes.noteTitle"]').element.value).toBe('')
  })

  it('switching section remembers it and flushes the open note first', async () => {
    fakeServer({
      sections: [
        { id: 's1', title: 'Work' },
        { id: 's2', title: 'Home' }
      ],
      notes: [{ id: 'n1', sectionId: 's1', title: 'A', content: 'old', excerpt: 'old' }]
    })
    await mountNotes()
    editor().vm.$emit('update:content', 'new body')
    expect(API_CLIENT.put).not.toHaveBeenCalled()

    await wrapper.find('[data-section-id="s2"]').trigger('click')
    await flushPromises()

    expect(putCalls()).toEqual([[`${BASE}/n1`, { content: 'new body' }]])
    expect(localStorage.getItem('notes.lastSection.site-1')).toBe('s2')
    expect(editor().exists()).toBe(false)
  })

  it('autosaves content and title, and an untitled note shows its first line', async () => {
    fakeServer({
      sections: [{ id: 's1', title: 'Work' }],
      notes: [{ id: 'n1', sectionId: 's1', title: null, content: '', excerpt: '' }]
    })
    await mountNotes()
    expect(listLabels()).toEqual(['notes.untitledNote'])

    editor().vm.$emit('update:content', '# Groceries\n\nmilk')
    await nextTick()
    expect(listLabels()).toEqual(['Groceries'])
    expect(wrapper.find('.notes-save-indicator').text()).toBe('notes.saving')

    await wrapper.vm.autosave.flush()
    await flushPromises()
    expect(putCalls()).toEqual([[`${BASE}/n1`, { content: '# Groceries\n\nmilk' }]])
    expect(wrapper.find('.notes-save-indicator').text()).toBe('notes.saved')

    await wrapper.find('input[aria-label="notes.noteTitle"]').setValue('Shopping')
    await wrapper.vm.autosave.flush()
    expect(putCalls().at(-1)).toEqual([`${BASE}/n1`, { title: 'Shopping' }])
    expect(listLabels()).toEqual(['Shopping'])
  })

  it('adds a note in one click and opens it with the caret in the body', async () => {
    const db = fakeServer({ sections: [{ id: 's1', title: 'Work' }] })
    await mountNotes()

    await wrapper.find('.notes-list-add').trigger('click')
    await flushPromises()

    expect(db.notes).toHaveLength(1)
    expect(API_CLIENT.post).toHaveBeenCalledWith(BASE, {
      json: { sectionId: 's1', title: undefined, content: undefined }
    })
    expect(editor().props('autofocus')).toBe(true)
    expect(editor().props('content')).toBe('')
    expect(wrapper.find('.notes-list-item--active').attributes('data-note-id')).toBe(db.notes[0].id)
  })

  it('adds a section in one click, opens it and starts renaming it', async () => {
    const db = fakeServer({ sections: [{ id: 's1', title: 'Work' }] })
    await mountNotes()

    await wrapper.find('.notes-section-add').trigger('click')
    await flushPromises()

    expect(db.sections.map((s) => s.title)).toEqual(['Work', 'notes.newSectionTitle'])
    const input = wrapper.find('input[aria-label="notes.sectionTitle"]')
    expect(input.exists()).toBe(true)
    await input.setValue('Ideas')
    await input.trigger('keyup', { key: 'Enter' })
    await flushPromises()
    expect(putCalls().at(-1)).toEqual([`${BASE}/sections/${db.sections[1].id}`, { title: 'Ideas' }])
  })

  it('deletes a note only after confirmation', async () => {
    const db = fakeServer({
      sections: [{ id: 's1', title: 'Work' }],
      notes: [
        { id: 'n1', sectionId: 's1', title: 'First', content: 'a', excerpt: 'a' },
        { id: 'n2', sectionId: 's1', title: 'Second', content: 'b', excerpt: 'b' }
      ]
    })
    let accept = null
    confirm.mockImplementation(() => ({
      onOk: (cb) => {
        accept = cb
      }
    }))
    await mountNotes()

    await wrapper.find('[data-note-id="n1"] .notes-list-more').trigger('click')
    await nextTick()
    document.body.querySelector('.notes-list-delete-action').click()
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true, persistent: true })
    )
    expect(API_CLIENT.delete).not.toHaveBeenCalled()

    await accept()
    await flushPromises()
    expect(API_CLIENT.delete).toHaveBeenCalledWith(`${BASE}/n1`)
    expect(db.notes.map((n) => n.id)).toEqual(['n2'])
    expect(listLabels()).toEqual(['Second'])
    expect(editor().props('content')).toBe('b')
  })

  it('deletes a section only after confirmation, then opens the next one', async () => {
    fakeServer({
      sections: [
        { id: 's1', title: 'Work' },
        { id: 's2', title: 'Home' }
      ],
      notes: [{ id: 'n2', sectionId: 's2', title: 'Chores', content: 'c', excerpt: 'c' }]
    })
    let accept = null
    confirm.mockImplementation(() => ({
      onOk: (cb) => {
        accept = cb
      }
    }))
    await mountNotes()

    await wrapper.find('.notes-section-more').trigger('click')
    await nextTick()
    document.body.querySelector('.notes-section-more-delete').click()
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true, persistent: true })
    )
    expect(API_CLIENT.delete).not.toHaveBeenCalled()

    await accept()
    await flushPromises()
    expect(API_CLIENT.delete).toHaveBeenCalledWith(`${BASE}/sections/s1`)
    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual(['Home'])
    expect(listLabels()).toEqual(['Chores'])
    expect(editor().props('content')).toBe('c')
  })

  it('moves a note to another section from its menu', async () => {
    fakeServer({
      sections: [
        { id: 's1', title: 'Work' },
        { id: 's2', title: 'Home' }
      ],
      notes: [{ id: 'n1', sectionId: 's1', title: 'Misfiled', content: 'a', excerpt: 'a' }]
    })
    await mountNotes()

    await wrapper.find('[data-note-id="n1"] .notes-list-more').trigger('click')
    await nextTick()
    document.body.querySelector('.notes-list-move-action[data-target-section-id="s2"]').click()
    await flushPromises()

    expect(putCalls()).toEqual([[`${BASE}/n1`, { sectionId: 's2' }]])
    expect(listLabels()).toEqual([])
  })

  it('moves a note dropped on a section tab, and a drag-end reorder leaves it out', async () => {
    fakeServer({
      sections: [
        { id: 's1', title: 'Work' },
        { id: 's2', title: 'Home' }
      ],
      notes: [
        { id: 'n1', sectionId: 's1', title: 'A', content: 'a', excerpt: 'a' },
        { id: 'n2', sectionId: 's1', title: 'B', content: 'b', excerpt: 'b' }
      ]
    })
    await mountNotes()

    await wrapper.find('[data-section-id="s2"]').trigger('drop', {
      dataTransfer: {
        types: ['application/x-cardinal-note'],
        getData: () => 'n2'
      }
    })
    wrapper
      .findComponent({ name: 'NotesList' })
      .findComponent({ name: 'WSortable' })
      .vm.$emit('update', { oldIndex: 1, newIndex: 0 })
    await flushPromises()

    expect(putCalls()).toEqual([
      [`${BASE}/order`, { sectionId: 's1', ids: ['n1'] }],
      [`${BASE}/n2`, { sectionId: 's2' }]
    ])
    expect(listLabels()).toEqual(['A'])
  })

  it('puts the note back when the move fails', async () => {
    fakeServer({
      sections: [
        { id: 's1', title: 'Work' },
        { id: 's2', title: 'Home' }
      ],
      notes: [{ id: 'n1', sectionId: 's1', title: 'A', content: 'a', excerpt: 'a' }]
    })
    await mountNotes()
    API_CLIENT.put.mockImplementationOnce(() => ({
      json: () => Promise.reject(new Error('offline'))
    }))

    await wrapper.find('[data-section-id="s2"]').trigger('drop', {
      dataTransfer: {
        types: ['application/x-cardinal-note'],
        getData: () => 'n1'
      }
    })
    await flushPromises()

    expect(listLabels()).toEqual(['A'])
  })

  it('reorders notes optimistically', async () => {
    fakeServer({
      sections: [{ id: 's1', title: 'Work' }],
      notes: [
        { id: 'n1', sectionId: 's1', title: 'A', content: '', excerpt: '' },
        { id: 'n2', sectionId: 's1', title: 'B', content: '', excerpt: '' }
      ]
    })
    await mountNotes()
    wrapper
      .findComponent({ name: 'NotesList' })
      .findComponent({ name: 'WSortable' })
      .vm.$emit('update', { oldIndex: 1, newIndex: 0 })
    await flushPromises()

    expect(putCalls()).toEqual([[`${BASE}/order`, { sectionId: 's1', ids: ['n2', 'n1'] }]])
    expect(listLabels()).toEqual(['B', 'A'])
  })

  it('uploads an image into the open note and refuses anything else', async () => {
    fakeServer({
      sections: [{ id: 's1', title: 'Work' }],
      notes: [{ id: 'n1', sectionId: 's1', title: 'A', content: '', excerpt: '' }]
    })
    await mountNotes()
    const upload = editor().props('uploadFile')

    const image = new File(['x'], 'shot.png', { type: 'image/png' })
    expect(await upload(image)).toEqual({
      url: `/_api/${BASE}/n1/images/img1`,
      name: 'shot.png'
    })
    expect(API_CLIENT.post.mock.calls.at(-1)[0]).toBe(`${BASE}/n1/images`)

    const calls = API_CLIENT.post.mock.calls.length
    expect(await upload(new File(['x'], 'a.pdf', { type: 'application/pdf' }))).toBeNull()
    expect(API_CLIENT.post.mock.calls).toHaveLength(calls)
  })

  describe('?new=1 from the quick-note entry points', () => {
    it('creates a default section when the user has none, then a note in it', async () => {
      const db = fakeServer()
      const { router } = await mountNotes({ path: '/_notes?new=1' })
      await flushPromises()

      expect(db.sections.map((s) => s.title)).toEqual(['notes.defaultSectionTitle'])
      expect(db.notes).toHaveLength(1)
      expect(db.notes[0].sectionId).toBe(db.sections[0].id)
      expect(editor().props('autofocus')).toBe(true)
      expect(router.currentRoute.value.query.new).toBeUndefined()
    })

    it('creates the note in the last-used section without opening another note first', async () => {
      const db = fakeServer({
        sections: [
          { id: 's1', title: 'Work' },
          { id: 's2', title: 'Home' }
        ],
        notes: [{ id: 'n1', sectionId: 's2', title: 'Old', content: 'old', excerpt: 'old' }]
      })
      localStorage.setItem('notes.lastSection.site-1', 's2')
      await mountNotes({ path: '/_notes?new=1' })
      await flushPromises()

      const created = db.notes.find((n) => n.id !== 'n1')
      expect(created.sectionId).toBe('s2')
      expect(API_CLIENT.get).not.toHaveBeenCalledWith(`${BASE}/n1`)
      expect(editor().props('content')).toBe('')
      expect(listLabels()).toEqual(['Old', 'notes.untitledNote'])
    })

    it('handles the query again while the screen is already open', async () => {
      const db = fakeServer({ sections: [{ id: 's1', title: 'Work' }] })
      const { router } = await mountNotes()
      expect(db.notes).toHaveLength(0)

      await router.push('/_notes?new=1')
      await flushPromises()
      expect(db.notes).toHaveLength(1)
      expect(router.currentRoute.value.query.new).toBeUndefined()
    })
  })

  describe('promote to page', () => {
    const SAVED_AT = '2026-09-23T09:00:00.000Z'

    function answerPromoteDialog(destination) {
      dialog.mockImplementation(() => {
        const chain = {
          onOk(cb) {
            if (destination) {
              cb(destination)
            }
            return chain
          },
          onCancel(cb) {
            if (!destination) {
              cb()
            }
            return chain
          }
        }
        return chain
      })
    }

    function promoteButton() {
      return wrapper.find('.notes-page-header .notes-page-promote')
    }

    async function mountForPromote(notes) {
      const db = fakeServer({ sections: [{ id: 's1', title: 'Work' }], notes })
      const mounted = await mountNotes()
      vi.spyOn(mounted.editorStore, 'ensureConfigs').mockResolvedValue()
      const push = vi.spyOn(mounted.router, 'push')
      return { db, push }
    }

    async function clickPromote() {
      await promoteButton().trigger('click')
      await flushPromises()
    }

    it("sits in the open note's header beside its title, and only while a note is open", async () => {
      await mountForPromote([
        {
          id: 'n1',
          sectionId: 's1',
          title: 'Plan',
          content: 'x',
          excerpt: 'x',
          updatedAt: SAVED_AT
        }
      ])

      const header = wrapper.find('.notes-page-header')
      expect(header.find('input[aria-label="notes.noteTitle"]').exists()).toBe(true)
      expect(promoteButton().text()).toBe('notes.promote.action')
      expect(wrapper.find('.notes-page-sidebar .notes-page-promote').exists()).toBe(false)

      wrapper.vm.state.current = null
      await nextTick()
      expect(promoteButton().exists()).toBe(false)
    })

    it("prefills the picker from the note's title, or its first line when it has none", async () => {
      answerPromoteDialog(null)
      await mountForPromote([
        {
          id: 'n1',
          sectionId: 's1',
          title: null,
          content: 'old',
          excerpt: 'old',
          updatedAt: SAVED_AT
        }
      ])

      editor().vm.$emit('update:content', '# Kickoff agenda\n\n- intro')
      await clickPromote()
      expect(dialog.mock.calls[0][0].componentProps).toEqual({
        mode: 'savePage',
        itemTitle: 'Kickoff agenda'
      })

      await wrapper.find('input[aria-label="notes.noteTitle"]').setValue('Agenda')
      await clickPromote()
      expect(dialog.mock.calls[1][0].componentProps.itemTitle).toBe('Agenda')
      expect(API_CLIENT.post).not.toHaveBeenCalledWith(`${BASE}/n1/promote`, expect.anything())
    })

    it('promotes the note, drops it from the list and opens the new page', async () => {
      answerPromoteDialog({ path: 'docs/plan', title: 'Plan' })
      const { db, push } = await mountForPromote([
        {
          id: 'n1',
          sectionId: 's1',
          title: 'Plan',
          content: 'Body',
          excerpt: 'Body',
          updatedAt: SAVED_AT
        },
        {
          id: 'n2',
          sectionId: 's1',
          title: 'Other',
          content: 'y',
          excerpt: 'y',
          updatedAt: SAVED_AT
        }
      ])

      await clickPromote()

      expect(db.promoted).toEqual([
        expect.objectContaining({
          noteId: 'n1',
          path: 'docs/plan',
          title: 'Plan',
          noteUpdatedAt: SAVED_AT
        })
      ])
      expect(push).toHaveBeenCalledWith('/docs/plan')
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'positive', message: 'notes.promote.success' })
      )
      expect(listLabels()).toEqual(['Other'])
      expect(wrapper.vm.state.current).toBeNull()
    })

    it("sends the updatedAt of the note's last autosave, not the one it was opened with", async () => {
      answerPromoteDialog({ path: 'docs/plan', title: 'Plan' })
      const { db, push } = await mountForPromote([
        {
          id: 'n1',
          sectionId: 's1',
          title: 'Plan',
          content: 'v1',
          excerpt: 'v1',
          updatedAt: SAVED_AT
        }
      ])

      editor().vm.$emit('update:content', 'v2')
      await wrapper.vm.autosave.flush()
      const savedAt = db.notes[0].updatedAt
      expect(savedAt).not.toBe(SAVED_AT)
      expect(wrapper.vm.state.current.updatedAt).toBe(savedAt)

      await clickPromote()

      expect(db.promoted).toEqual([
        expect.objectContaining({ noteId: 'n1', content: 'v2', noteUpdatedAt: savedAt })
      ])
      expect(push).toHaveBeenCalledWith('/docs/plan')
    })

    it('saves a pending edit before promoting, so the page gets the latest content', async () => {
      answerPromoteDialog({ path: 'docs/plan', title: 'Plan' })
      const { db, push } = await mountForPromote([
        {
          id: 'n1',
          sectionId: 's1',
          title: 'Plan',
          content: 'v1',
          excerpt: 'v1',
          updatedAt: SAVED_AT
        }
      ])

      editor().vm.$emit('update:content', 'typed just now')
      expect(API_CLIENT.put).not.toHaveBeenCalled()
      await clickPromote()

      expect(putCalls()).toEqual([[`${BASE}/n1`, { content: 'typed just now' }]])
      const putOrder = API_CLIENT.put.mock.invocationCallOrder[0]
      const promoteCall = API_CLIENT.post.mock.calls.findIndex(([url]) => url.endsWith('/promote'))
      expect(putOrder).toBeLessThan(API_CLIENT.post.mock.invocationCallOrder[promoteCall])
      expect(db.promoted[0]).toMatchObject({ content: 'typed just now' })
      expect(db.promoted[0].render).toContain('typed just now')
      expect(push).toHaveBeenCalledWith('/docs/plan')
    })

    it('does not promote when the pending edit cannot be saved', async () => {
      answerPromoteDialog({ path: 'docs/plan', title: 'Plan' })
      const { db, push } = await mountForPromote([
        {
          id: 'n1',
          sectionId: 's1',
          title: 'Plan',
          content: 'v1',
          excerpt: 'v1',
          updatedAt: SAVED_AT
        }
      ])
      API_CLIENT.put.mockImplementation(() => ({
        json: () => Promise.reject(refusal(503, 'unavailable', 'Try later.'))
      }))

      editor().vm.$emit('update:content', 'unsaved')
      await clickPromote()

      expect(db.promoted).toEqual([])
      expect(push).not.toHaveBeenCalled()
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'negative',
          message: 'notes.promote.failed',
          caption: 'notes.saveFailed'
        })
      )
      expect(listLabels()).toEqual(['Plan'])
    })

    it.each([
      [
        'a page already at the path',
        'pageDuplicatePath',
        409,
        'A page already exists at this path.'
      ],
      ['no write:pages there', 'forbidden', 403, 'You are not allowed to create a page here.'],
      [
        'a note saved elsewhere',
        'noteChanged',
        409,
        'The note changed while it was being promoted. Try again.'
      ]
    ])(
      'surfaces a refusal for %s and keeps the note open',
      async (_case, error, status, message) => {
        answerPromoteDialog({ path: 'docs/plan', title: 'Plan' })
        const { push } = await mountForPromote([
          {
            id: 'n1',
            sectionId: 's1',
            title: 'Plan',
            content: 'v1',
            excerpt: 'v1',
            updatedAt: SAVED_AT
          }
        ])
        API_CLIENT.post.mockImplementationOnce(() => ({
          json: () => Promise.reject(refusal(status, error, message))
        }))

        await clickPromote()

        expect(push).not.toHaveBeenCalled()
        expect(notify).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'negative',
            message: 'notes.promote.failed',
            caption: message
          })
        )
        expect(listLabels()).toEqual(['Plan'])
        expect(wrapper.vm.state.current?.id).toBe('n1')
        expect(promoteButton().attributes('aria-busy')).toBeUndefined()
      }
    )
  })
})
