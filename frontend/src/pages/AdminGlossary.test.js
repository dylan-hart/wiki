import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AdminGlossary from './AdminGlossary.vue'
import GlossaryImportDialog from '@/components/GlossaryImportDialog.vue'
import GlossaryTermDialog from '@/components/GlossaryTermDialog.vue'
import GlossaryVersionHistoryDialog from '@/components/GlossaryVersionHistoryDialog.vue'
import { dialog, confirm } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { mountWithApp } from '../../test/mount.js'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn(() => ({ onOk: vi.fn() })),
  // -> `.onOk(cb)` runs `cb` at once: what is under test is what happens once the user has agreed,
  //    not the confirmation UI.
  confirm: vi.fn(() => ({ onOk: (cb) => cb() }))
}))

const fileSave = vi.fn()
vi.mock('browser-fs-access', () => ({
  fileSave: (...args) => fileSave(...args)
}))

// -> `vi.mock` factories cannot close over per-test locals, so `fileSave` lives at module scope and
//    keeps its call history between tests unless cleared -- unlike `API_CLIENT`, which
//    `test/setup.js` rebuilds per test.
beforeEach(() => {
  fileSave.mockClear()
  notifyQueue.splice(0, notifyQueue.length)
})

const EXPORT_TERMS = [
  {
    term: 'API',
    definition: 'Application Programming Interface.',
    isAcronym: true,
    aliases: [],
    path: null
  },
  {
    term: 'REST',
    definition: 'Representational State Transfer.',
    isAcronym: false,
    aliases: [{ value: 'R', isAcronym: true }],
    path: 'dev/api'
  }
]

function mountAdminGlossary(terms = EXPORT_TERMS, siteOverrides = {}) {
  API_CLIENT.get.mockReturnValue({
    json: () => Promise.resolve({ formatVersion: 1, terms })
  })

  const { wrapper } = mountWithApp(AdminGlossary, {
    stores: { admin: { currentSiteId: 'site-1' }, site: siteOverrides }
  })
  return wrapper
}

/**
 * Glossary editing is staged: add/edit/delete touch only the local `state.terms` working copy, and
 * nothing reaches the API until `saveGlossary()`.
 */
describe('AdminGlossary: load()', () => {
  it('loads via the export endpoint -- the SAME shape save/import both take (OpenProject #1114)', async () => {
    mountAdminGlossary()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/glossary/export')
  })

  it('renders every term with its definition and aliases', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    expect(wrapper.text()).toContain('API')
    expect(wrapper.text()).toContain('Application Programming Interface.')
    expect(wrapper.text()).toContain('REST')
    expect(wrapper.text()).toContain('R')
  })

  it('shows the empty-state banner with no terms', async () => {
    const wrapper = mountAdminGlossary([])
    await flushPromises()

    expect(wrapper.text()).toContain('admin.glossary.noTerms')
  })

  it("places each term's definition in the row's hint, not run together with the term name", async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    // -> A `WSettingsRow` has one text column, so the definition belongs in the hint slot.
    const row = wrapper.find('.w-settings-row')

    expect(row.find('.w-settings-row__label').text()).not.toContain(
      'Application Programming Interface.'
    )
    expect(row.find('.w-settings-row__hint').text()).toContain('Application Programming Interface.')
  })

  it('is not dirty right after loading', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    expect(wrapper.vm.isDirty).toBe(false)
  })
})

describe('AdminGlossary: staged create/edit (no API call)', () => {
  it('opens GlossaryTermDialog with no term prop for a new term', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    wrapper.vm.createTerm()

    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        component: GlossaryTermDialog,
        componentProps: { siteId: 'site-1' }
      })
    )
  })

  it("appends the dialog's result to the staged list and marks it dirty, without calling the API", async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()
    API_CLIENT.post.mockClear()

    dialog.mockReturnValueOnce({
      onOk: (cb) => cb({ term: 'New', definition: 'A new term.', aliases: [], path: null })
    })
    wrapper.vm.createTerm()

    expect(wrapper.vm.state.terms.map((t) => t.term)).toEqual(['API', 'REST', 'New'])
    expect(wrapper.vm.isDirty).toBe(true)
    expect(API_CLIENT.post).not.toHaveBeenCalled()
  })

  it('opens GlossaryTermDialog seeded with the staged term being edited', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    wrapper.vm.editTerm(wrapper.vm.state.terms[0])

    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: expect.objectContaining({ term: expect.objectContaining({ term: 'API' }) })
      })
    )
  })

  it('replaces the edited entry in place, keeping its position, without calling the API', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()
    API_CLIENT.put.mockClear()

    dialog.mockReturnValueOnce({
      onOk: (cb) => cb({ term: 'API', definition: 'Updated definition.', aliases: [], path: null })
    })
    wrapper.vm.editTerm(wrapper.vm.state.terms[0])

    expect(wrapper.vm.state.terms[0].definition).toBe('Updated definition.')
    expect(wrapper.vm.state.terms.map((t) => t.term)).toEqual(['API', 'REST'])
    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })
})

describe('AdminGlossary: staged delete (no API call)', () => {
  it('removes the term locally once confirmed, without calling the API', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()
    API_CLIENT.delete.mockClear()

    wrapper.vm.deleteTerm(wrapper.vm.state.terms[0])

    expect(confirm).toHaveBeenCalled()
    expect(wrapper.vm.state.terms.map((t) => t.term)).toEqual(['REST'])
    expect(API_CLIENT.delete).not.toHaveBeenCalled()
    expect(wrapper.vm.isDirty).toBe(true)
  })
})

describe('AdminGlossary: saveGlossary()', () => {
  it('posts the stripped staged terms to .../glossary/save, then reloads', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    wrapper.vm.state.terms.push({
      term: 'New',
      definition: 'A new term.',
      isAcronym: false,
      aliases: [],
      path: null,
      _key: 'local-only'
    })

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          terms: [],
          version: { id: 'v1', termCount: 3, actorId: null, actorName: '' }
        })
    })

    await wrapper.vm.saveGlossary()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'sites/site-1/glossary/save',
      expect.objectContaining({
        json: {
          terms: [
            {
              term: 'API',
              definition: 'Application Programming Interface.',
              isAcronym: true,
              aliases: [],
              path: null
            },
            {
              term: 'REST',
              definition: 'Representational State Transfer.',
              isAcronym: false,
              aliases: [{ value: 'R', isAcronym: true }],
              path: 'dev/api'
            },
            {
              term: 'New',
              definition: 'A new term.',
              isAcronym: false,
              aliases: [],
              path: null
            }
          ]
        }
      })
    )
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/glossary/export')
  })

  it('is dirty before saving and clean again after a successful save', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()
    wrapper.vm.state.terms[0].definition = 'Changed.'
    expect(wrapper.vm.isDirty).toBe(true)

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          terms: [],
          version: { id: 'v1', termCount: 2, actorId: null, actorName: '' }
        })
    })
    await wrapper.vm.saveGlossary()

    expect(wrapper.vm.isDirty).toBe(false)
  })

  it('leaves the staged edit in place and surfaces the server message on refusal', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()
    wrapper.vm.state.terms[0].definition = 'Changed.'
    const getCallsBefore = API_CLIENT.get.mock.calls.length

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.reject({ data: { message: 'That definition is too long.' } })
    })

    await wrapper.vm.saveGlossary()

    expect(wrapper.vm.state.terms[0].definition).toBe('Changed.')
    expect(wrapper.vm.isDirty).toBe(true)
    expect(API_CLIENT.get.mock.calls.length).toBe(getCallsBefore)
    expect(wrapper.vm.state.saving).toBe(false)
  })
})

describe('AdminGlossary: discardChanges()', () => {
  it('confirms, then reloads from the server, discarding local edits', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()
    wrapper.vm.state.terms[0].definition = 'Locally changed, not saved.'
    expect(wrapper.vm.isDirty).toBe(true)

    wrapper.vm.discardChanges()
    await flushPromises()

    expect(confirm).toHaveBeenCalled()
    expect(wrapper.vm.state.terms[0].definition).toBe('Application Programming Interface.')
    expect(wrapper.vm.isDirty).toBe(false)
  })
})

describe('AdminGlossary: export/import (OpenProject #1114)', () => {
  it('exportGlossary() re-fetches the export and hands it to fileSave', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    await wrapper.vm.exportGlossary()

    expect(fileSave).toHaveBeenCalledTimes(1)
    const [blob, opts] = fileSave.mock.calls[0]
    expect(blob).toBeInstanceOf(Blob)
    expect(opts.fileName).toBe('glossary.json')
  })

  it('exportGlossary() refuses to export an empty glossary', async () => {
    const wrapper = mountAdminGlossary([])
    await flushPromises()

    await wrapper.vm.exportGlossary()

    expect(fileSave).not.toHaveBeenCalled()
  })

  it('openImportDialog() opens GlossaryImportDialog for the current site, reloading on ok', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()
    API_CLIENT.get.mockClear()

    dialog.mockReturnValueOnce({ onOk: (cb) => cb() })
    wrapper.vm.openImportDialog()

    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        component: GlossaryImportDialog,
        componentProps: { siteId: 'site-1' }
      })
    )
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/glossary/export')
  })
})

describe('AdminGlossary: version history', () => {
  it('opens GlossaryVersionHistoryDialog with the current staged terms', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    wrapper.vm.openVersionHistory()

    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        component: GlossaryVersionHistoryDialog,
        componentProps: {
          siteId: 'site-1',
          currentTerms: [
            {
              term: 'API',
              definition: 'Application Programming Interface.',
              isAcronym: true,
              aliases: [],
              path: null
            },
            {
              term: 'REST',
              definition: 'Representational State Transfer.',
              isAcronym: false,
              aliases: [{ value: 'R', isAcronym: true }],
              path: 'dev/api'
            }
          ]
        }
      })
    )
  })
})

describe('AdminGlossary: rerenderAllPages() (OpenProject #3181)', () => {
  it('is hidden when this instance cannot render server-side', async () => {
    const wrapper = mountAdminGlossary(EXPORT_TERMS, { pdfExportAvailable: false })
    await flushPromises()

    expect(wrapper.find('[data-icon="tabler:wand"]').exists()).toBe(false)
  })

  it('is shown when this instance can render server-side', async () => {
    const wrapper = mountAdminGlossary(EXPORT_TERMS, { pdfExportAvailable: true })
    await flushPromises()

    expect(wrapper.find('[data-icon="tabler:wand"]').exists()).toBe(true)
  })

  it('confirms, then queues every page and reports how many', async () => {
    const wrapper = mountAdminGlossary(EXPORT_TERMS, { pdfExportAvailable: true })
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, queued: 5 })
    })

    wrapper.vm.rerenderAllPages()
    await flushPromises()

    expect(confirm).toHaveBeenCalled()
    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/glossary/rerender-all-pages')
    // -> No message catalog under test, so `{count}` interpolation cannot be asserted on.
    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
  })

  it('surfaces the server message on refusal', async () => {
    const wrapper = mountAdminGlossary(EXPORT_TERMS, { pdfExportAvailable: true })
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.reject({ data: { message: 'Rendering needs Puppeteer.' } })
    })

    wrapper.vm.rerenderAllPages()
    await flushPromises()

    const negative = notifyQueue.find((n) => n.type === 'negative')
    expect(negative).toBeTruthy()
    expect(negative.caption).toMatch(/puppeteer/i)
  })
})

// -> Glossary management is a fork-invented surface with no upstream docs page, so a help button
//    here could only point at a URL that does not exist.
describe('AdminGlossary help link', () => {
  it('has no help/docs button', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    expect(wrapper.html()).not.toContain('/admin/glossary')
  })
})
