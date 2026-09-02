import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminGlossary from './AdminGlossary.vue'
import GlossaryImportDialog from '@/components/GlossaryImportDialog.vue'
import GlossaryTermDialog from '@/components/GlossaryTermDialog.vue'
import GlossaryVersionHistoryDialog from '@/components/GlossaryVersionHistoryDialog.vue'
import { useAdminStore } from '@/stores/admin'
import { dialog, confirm } from '@/composables/dialog'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn(() => ({ onOk: vi.fn() })),
  // -> `.onOk(cb)` runs `cb` at once rather than waiting on a real confirmation dialog's own click,
  //    the same way `AdminApprovals.vue`'s equivalent flow would need mocking if it had a test --
  //    what matters here is that the callback DOES the right thing once the user has agreed, not the
  //    confirmation UI itself.
  confirm: vi.fn(() => ({ onOk: (cb) => cb() }))
}))

const fileSave = vi.fn()
vi.mock('browser-fs-access', () => ({
  fileSave: (...args) => fileSave(...args)
}))

// -> Declared at module scope (`vi.mock` factories can't close over per-test locals), so unlike
//    `API_CLIENT` -- rebuilt fresh per test by `test/setup.js` -- this needs its own call history
//    cleared here, or an earlier test's call would still be there for a later `not
//    .toHaveBeenCalled()` assertion to trip over.
beforeEach(() => {
  fileSave.mockClear()
})

const EXPORT_TERMS = [
  { term: 'API', definition: 'Application Programming Interface.', aliases: [], path: null },
  { term: 'REST', definition: 'Representational State Transfer.', aliases: ['R'], path: 'dev/api' }
]

function mountAdminGlossary(terms = EXPORT_TERMS) {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  API_CLIENT.get.mockReturnValue({
    json: () => Promise.resolve({ formatVersion: 1, terms })
  })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(AdminGlossary, {
    global: {
      plugins: [i18n]
    }
  })
  return wrapper
}

/**
 * Glossary admin editing is a staged workflow (OpenProject #1113): every add/edit/delete touches only
 * the local `state.terms` working copy, and nothing reaches the API until `saveGlossary()` -- these
 * tests cover that split directly, rather than the pre-#1113 immediate-apply behavior.
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

  it("places each term's definition in its own item-section, not under the term name", async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    const row = wrapper.find('.w-item')
    // -> The first section is `BlueprintIcon`'s own `<w-item-section avatar>` (registered globally
    //    by `test/setup.js`, exactly as `boot/components.js` registers it in the app); the term and
    //    its definition are the two after it.
    const [, termSection, definitionSection] = row.findAll('.w-item-section')

    expect(termSection.text()).not.toContain('Application Programming Interface.')
    expect(definitionSection.text()).toBe('Application Programming Interface.')
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
              aliases: [],
              path: null
            },
            {
              term: 'REST',
              definition: 'Representational State Transfer.',
              aliases: ['R'],
              path: 'dev/api'
            },
            { term: 'New', definition: 'A new term.', aliases: [], path: null }
          ]
        }
      })
    )
    // -> Reloads from `export` right after -- see the component's own comment on why
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

    // -> No reload on refusal, so the staged edit -- and the dirty flag it produced -- both survive.
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
    // -> `.onOk(cb)` above runs `load` immediately -- see the module-level `dialog` mock's own comment
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
              aliases: [],
              path: null
            },
            {
              term: 'REST',
              definition: 'Representational State Transfer.',
              aliases: ['R'],
              path: 'dev/api'
            }
          ]
        }
      })
    )
  })
})

// -> OpenProject #1929: `/admin/glossary` names a concept this fork invented (glossary management is
//    not an upstream Wiki.js feature), so no docs site can describe it -- the help button was deleted
//    rather than left pointing at a page that does not exist.
describe('AdminGlossary help link', () => {
  it('has no help/docs button', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    expect(wrapper.html()).not.toContain('/admin/glossary')
  })
})
