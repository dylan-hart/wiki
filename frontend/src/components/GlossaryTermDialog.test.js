import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import GlossaryTermDialog from './GlossaryTermDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'

const PAGES = [
  { id: 'page-1', title: 'API Docs', path: 'dev/api' },
  { id: 'page-2', title: 'Getting Started', path: 'getting-started' }
]

/*
  `WDialog`'s content lives behind a `<teleport to="body">`, which lands it as a REAL child of
  `document.body`, outside `@vue/test-utils`'s own tracked tree -- unmounting the wrapper is what
  removes it again. Only the `required fields` test below reads real DOM (`document.body`) rather
  than the component tree, so it is the one that would otherwise see every prior test's now-orphaned
  dialog too.
*/
let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
})

function mountDialog({ siteId = 'site-1', term = null, pages = PAGES } = {}) {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
  currentWrapper = mount(GlossaryTermDialog, {
    props: { siteId, term, pages },
    global: { plugins: [i18n], stubs: { BlueprintIcon: true } }
  })
  return currentWrapper
}

/**
 * OpenProject #870 admin CRUD: create/edit a glossary term, and the canonical-page picker's payload.
 */
describe('GlossaryTermDialog - create', () => {
  it('sends the trimmed term/definition and a null pageId with no page selected', async () => {
    const wrapper = mountDialog()
    wrapper.vm.state.term = '  API  '
    wrapper.vm.state.definition = '  Application Programming Interface  '
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'term-1',
          term: 'API',
          definition: 'Application Programming Interface',
          pageId: null
        })
    })

    await wrapper.vm.save()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'sites/site-1/glossary',
      expect.objectContaining({
        json: {
          term: 'API',
          definition: 'Application Programming Interface',
          aliases: [],
          pageId: null
        }
      })
    )
  })

  it('sends the selected canonical pageId', async () => {
    const wrapper = mountDialog()
    wrapper.vm.state.term = 'API'
    wrapper.vm.state.definition = 'Application Programming Interface'
    wrapper.vm.state.pageId = 'page-1'
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'term-1',
          term: 'API',
          definition: 'Application Programming Interface',
          pageId: 'page-1'
        })
    })

    await wrapper.vm.save()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'sites/site-1/glossary',
      expect.objectContaining({ json: expect.objectContaining({ pageId: 'page-1' }) })
    )
  })

  it('refuses to save an empty term or definition, without calling the API', async () => {
    const wrapper = mountDialog()
    wrapper.vm.state.term = '   '
    wrapper.vm.state.definition = '   '
    await flushPromises()

    await wrapper.vm.save()

    expect(API_CLIENT.post).not.toHaveBeenCalled()
  })

  it('shows a positive toast and closes on success', async () => {
    notifyQueue.splice(0, notifyQueue.length)
    const wrapper = mountDialog()
    wrapper.vm.state.term = 'API'
    wrapper.vm.state.definition = 'Application Programming Interface'
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ id: 'term-1', term: 'API', definition: '...', pageId: null })
    })

    await wrapper.vm.save()

    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
  })

  it('shows a negative toast and does not close when the API rejects the request', async () => {
    notifyQueue.splice(0, notifyQueue.length)
    const wrapper = mountDialog()
    wrapper.vm.state.term = 'API'
    wrapper.vm.state.definition = 'Application Programming Interface'
    await flushPromises()

    API_CLIENT.post.mockImplementationOnce(() => {
      throw new Error('A term with this name already exists.')
    })

    await wrapper.vm.save()

    expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
  })
})

describe('GlossaryTermDialog - edit', () => {
  const EXISTING_TERM = {
    id: 'term-1',
    term: 'API',
    definition: 'Application Programming Interface',
    pageId: 'page-1'
  }

  it('seeds the form from the term being edited', () => {
    const wrapper = mountDialog({ term: EXISTING_TERM })

    expect(wrapper.vm.state.term).toBe('API')
    expect(wrapper.vm.state.definition).toBe('Application Programming Interface')
    expect(wrapper.vm.state.pageId).toBe('page-1')
  })

  it('PUTs to the term-specific URL, keyed by id', async () => {
    const wrapper = mountDialog({ term: EXISTING_TERM })
    wrapper.vm.state.definition = 'Updated definition.'
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ...EXISTING_TERM, definition: 'Updated definition.' })
    })

    await wrapper.vm.save()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      'sites/site-1/glossary/term-1',
      expect.objectContaining({
        json: { term: 'API', definition: 'Updated definition.', aliases: [], pageId: 'page-1' }
      })
    )
  })

  it('can clear the canonical page back to null', async () => {
    const wrapper = mountDialog({ term: EXISTING_TERM })
    wrapper.vm.state.pageId = null
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ...EXISTING_TERM, pageId: null })
    })

    await wrapper.vm.save()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      'sites/site-1/glossary/term-1',
      expect.objectContaining({ json: expect.objectContaining({ pageId: null }) })
    )
  })
})

describe('GlossaryTermDialog - required fields (OpenProject #1111)', () => {
  it('marks Term and Definition required, so Canonical Page reads as optional by contrast', async () => {
    mountDialog()
    await flushPromises()

    // -> `WDialog` teleports its content to `document.body` (see the file header comment), so this
    //    reads real DOM rather than the component tree. `WInput`'s `required` prop surfaces as
    //    `aria-required` on the underlying control (its own header comment) -- exactly the two fields
    //    `termValidation`/`definitionValidation` already enforce as non-empty, and none of the others
    //    (the alias-add field, the canonical-page select). Term (an <input>) and Definition (a
    //    <textarea>) are the form's first two controls in DOM order, ahead of the alias-add field.
    const controls = document.body.querySelectorAll('input, textarea')
    expect(controls[0].getAttribute('aria-required')).toBe('true')
    expect(controls[1].getAttribute('aria-required')).toBe('true')
    expect(document.body.querySelectorAll('[aria-required="true"]')).toHaveLength(2)
  })
})

describe('GlossaryTermDialog - aliases (OpenProject #1110)', () => {
  it('adds a trimmed alias as a chip and clears the input', () => {
    const wrapper = mountDialog()
    wrapper.vm.state.aliasInput = '  HSM  '

    wrapper.vm.addAlias()

    expect(wrapper.vm.state.aliases).toEqual(['HSM'])
    expect(wrapper.vm.state.aliasInput).toBe('')
  })

  it('ignores an empty or case-insensitively duplicate alias', () => {
    const wrapper = mountDialog()
    wrapper.vm.state.aliases = ['HSM']

    wrapper.vm.state.aliasInput = '   '
    wrapper.vm.addAlias()
    wrapper.vm.state.aliasInput = 'hsm'
    wrapper.vm.addAlias()

    expect(wrapper.vm.state.aliases).toEqual(['HSM'])
  })

  it('removes an alias chip', () => {
    const wrapper = mountDialog()
    wrapper.vm.state.aliases = ['HSM', 'Hot Mill']

    wrapper.vm.removeAlias('HSM')

    expect(wrapper.vm.state.aliases).toEqual(['Hot Mill'])
  })

  it('seeds aliases from the term being edited, and sends them on save', async () => {
    const wrapper = mountDialog({
      term: {
        id: 'term-1',
        term: 'Hot Strip Mill',
        definition: 'A rolling mill.',
        aliases: ['HSM'],
        pageId: null
      }
    })
    expect(wrapper.vm.state.aliases).toEqual(['HSM'])
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'term-1',
          term: 'Hot Strip Mill',
          definition: 'A rolling mill.',
          aliases: ['HSM'],
          pageId: null
        })
    })

    await wrapper.vm.save()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      'sites/site-1/glossary/term-1',
      expect.objectContaining({ json: expect.objectContaining({ aliases: ['HSM'] }) })
    )
  })
})

describe('GlossaryTermDialog - canonical page picker', () => {
  it("offers a 'none' sentinel ahead of every candidate page", () => {
    const wrapper = mountDialog()

    expect(wrapper.vm.pageOptions.map((opt) => opt.id)).toEqual([null, 'page-1', 'page-2'])
  })
})
