import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminGlossary from './AdminGlossary.vue'
import GlossaryTermDialog from '@/components/GlossaryTermDialog.vue'
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

const TERMS = [
  { id: 'term-1', term: 'API', definition: 'Application Programming Interface.', pageId: null },
  { id: 'term-2', term: 'REST', definition: 'Representational State Transfer.', pageId: 'page-1' }
]

const PAGE_SEARCH_RESULTS = {
  results: [{ id: 'page-1', title: 'API Docs', path: 'dev/api', locale: 'en' }],
  totalHits: 1
}

function mountAdminGlossary(terms = TERMS) {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(terms) })
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(PAGE_SEARCH_RESULTS) })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(AdminGlossary, {
    global: {
      plugins: [i18n],
      stubs: { BlueprintIcon: true }
    }
  })
  return wrapper
}

/**
 * OpenProject #870 admin CRUD screen: loads the term list and the canonical-page candidates
 * together, and wires the New/Edit/Delete affordances to `GlossaryTermDialog` and a confirmation.
 */
describe('AdminGlossary: load()', () => {
  it("fetches this site's terms and a candidate page list for the picker", async () => {
    mountAdminGlossary()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/glossary')
    expect(API_CLIENT.get).toHaveBeenCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: { orderBy: 'title', orderByDirection: 'asc', limit: 100 }
      })
    )
  })

  it('renders every term with its definition', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    expect(wrapper.text()).toContain('API')
    expect(wrapper.text()).toContain('Application Programming Interface.')
    expect(wrapper.text()).toContain('REST')
  })

  it('shows the empty-state banner with no terms', async () => {
    const wrapper = mountAdminGlossary([])
    await flushPromises()

    expect(wrapper.text()).toContain('admin.glossary.noTerms')
  })
})

describe('AdminGlossary: create/edit', () => {
  it('opens GlossaryTermDialog with no term prop for a new term', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    await wrapper.vm.createTerm()

    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        component: GlossaryTermDialog,
        componentProps: expect.objectContaining({ siteId: 'site-1' })
      })
    )
    expect(dialog.mock.calls[0][0].componentProps.term).toBeUndefined()
  })

  it('opens GlossaryTermDialog seeded with the term being edited', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    await wrapper.vm.editTerm(TERMS[0])

    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: expect.objectContaining({ term: TERMS[0] })
      })
    )
  })
})

describe('AdminGlossary: delete', () => {
  it('deletes the term and reloads the list once the confirmation is accepted', async () => {
    const wrapper = mountAdminGlossary()
    await flushPromises()

    API_CLIENT.delete.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([TERMS[1]]) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(PAGE_SEARCH_RESULTS) })

    await wrapper.vm.deleteTerm(TERMS[0])
    await flushPromises()

    expect(confirm).toHaveBeenCalled()
    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/glossary/term-1')
    expect(wrapper.vm.state.terms).toEqual([TERMS[1]])
  })
})
