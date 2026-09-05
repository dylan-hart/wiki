import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import GlossaryTermDialog from './GlossaryTermDialog.vue'

import { createTestI18n } from '../../test/i18n.js'

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

function mountDialog({ siteId = 'site-1', term = null } = {}) {
  const i18n = createTestI18n()
  currentWrapper = mount(GlossaryTermDialog, {
    props: { siteId, term },
    global: { plugins: [i18n] }
  })
  return currentWrapper
}

/**
 * Glossary admin editing is a staged workflow (OpenProject #1113): this dialog collects/edits ONE
 * entry and hands it back to `AdminGlossary.vue` via `onDialogOK` -- it makes NO API call of its own,
 * unlike the pre-#1113 version this replaces. `AdminGlossary.vue`'s own tests cover what happens to
 * the returned entry once it reaches the staged list.
 */
describe('GlossaryTermDialog - create', () => {
  it('hands back the trimmed term/definition/aliases and a null path with none entered', async () => {
    API_CLIENT.get.mockReturnValue({ json: () => Promise.reject(new Error('no path to check')) })
    const wrapper = mountDialog()
    wrapper.vm.state.term = '  API  '
    wrapper.vm.state.definition = '  Application Programming Interface  '
    await flushPromises()

    await wrapper.vm.save()

    expect(wrapper.emitted().ok[0][0]).toEqual({
      term: 'API',
      definition: 'Application Programming Interface',
      isAcronym: false,
      aliases: [],
      path: null
    })
  })

  it('hands back the entered canonical page path', async () => {
    API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ id: 'page-1', title: 'API Docs', path: 'dev/api' })
    })
    const wrapper = mountDialog()
    wrapper.vm.state.term = 'API'
    wrapper.vm.state.definition = 'Application Programming Interface'
    wrapper.vm.state.path = 'dev/api'
    await flushPromises()

    await wrapper.vm.save()

    expect(wrapper.emitted().ok[0][0].path).toBe('dev/api')
  })

  it('refuses to hand back an empty term or definition', async () => {
    const wrapper = mountDialog()
    wrapper.vm.state.term = '   '
    wrapper.vm.state.definition = '   '
    await flushPromises()

    await wrapper.vm.save()

    expect(wrapper.emitted().ok).toBeUndefined()
  })
})

describe('GlossaryTermDialog - edit', () => {
  const EXISTING_TERM = {
    term: 'API',
    definition: 'Application Programming Interface',
    isAcronym: true,
    aliases: [{ value: 'A.P.I.', isAcronym: false }],
    path: 'dev/api'
  }

  it('seeds the form from the term being edited', () => {
    API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ id: 'page-1', title: 'API Docs', path: 'dev/api' })
    })
    const wrapper = mountDialog({ term: EXISTING_TERM })

    expect(wrapper.vm.state.term).toBe('API')
    expect(wrapper.vm.state.definition).toBe('Application Programming Interface')
    expect(wrapper.vm.state.isAcronym).toBe(true)
    expect(wrapper.vm.state.aliases).toEqual([{ value: 'A.P.I.', isAcronym: false }])
    expect(wrapper.vm.state.path).toBe('dev/api')
  })

  it('hands back the edited fields', async () => {
    API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ id: 'page-1', title: 'API Docs', path: 'dev/api' })
    })
    const wrapper = mountDialog({ term: EXISTING_TERM })
    wrapper.vm.state.definition = 'Updated definition.'
    await flushPromises()

    await wrapper.vm.save()

    expect(wrapper.emitted().ok[0][0]).toEqual({
      term: 'API',
      definition: 'Updated definition.',
      isAcronym: true,
      aliases: [{ value: 'A.P.I.', isAcronym: false }],
      path: 'dev/api'
    })
  })

  it('can clear the canonical path back to null', async () => {
    API_CLIENT.get.mockReturnValue({ json: () => Promise.reject(new Error('no path')) })
    const wrapper = mountDialog({ term: EXISTING_TERM })
    wrapper.vm.state.path = ''
    await flushPromises()

    await wrapper.vm.save()

    expect(wrapper.emitted().ok[0][0].path).toBe(null)
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
    //    (the alias-add field, the canonical-page path input). Term (an <input>) and Definition (a
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

    expect(wrapper.vm.state.aliases).toEqual([{ value: 'HSM', isAcronym: false }])
    expect(wrapper.vm.state.aliasInput).toBe('')
  })

  it('ignores an empty or case-insensitively duplicate alias', () => {
    const wrapper = mountDialog()
    wrapper.vm.state.aliases = [{ value: 'HSM', isAcronym: false }]

    wrapper.vm.state.aliasInput = '   '
    wrapper.vm.addAlias()
    wrapper.vm.state.aliasInput = 'hsm'
    wrapper.vm.addAlias()

    expect(wrapper.vm.state.aliases).toEqual([{ value: 'HSM', isAcronym: false }])
  })

  it('ignores an alias that only differs from the term by case (OpenProject #1110)', () => {
    const wrapper = mountDialog()
    wrapper.vm.state.term = 'API'

    wrapper.vm.state.aliasInput = 'api'
    wrapper.vm.addAlias()

    expect(wrapper.vm.state.aliases).toEqual([])
  })

  it('removes an alias chip', () => {
    const wrapper = mountDialog()
    wrapper.vm.state.aliases = [
      { value: 'HSM', isAcronym: false },
      { value: 'Hot Mill', isAcronym: false }
    ]

    wrapper.vm.removeAlias('HSM')

    expect(wrapper.vm.state.aliases).toEqual([{ value: 'Hot Mill', isAcronym: false }])
  })
})

describe('GlossaryTermDialog - acronyms (OpenProject #2575)', () => {
  it('adds an alias as an acronym when the acronym toggle is checked', () => {
    const wrapper = mountDialog()
    wrapper.vm.state.aliasIsAcronym = true
    wrapper.vm.state.aliasInput = 'USS'

    wrapper.vm.addAlias()

    expect(wrapper.vm.state.aliases).toEqual([{ value: 'USS', isAcronym: true }])
  })

  it('defaults isAcronym to false for a new term', () => {
    const wrapper = mountDialog()

    expect(wrapper.vm.state.isAcronym).toBe(false)
  })

  it('toggleAliasAcronym() flips one alias’s flag without touching the others', () => {
    const wrapper = mountDialog()
    const uss = { value: 'USS', isAcronym: false }
    const api = { value: 'API', isAcronym: true }
    wrapper.vm.state.aliases = [uss, api]

    wrapper.vm.toggleAliasAcronym(uss)

    expect(wrapper.vm.state.aliases).toEqual([
      { value: 'USS', isAcronym: true },
      { value: 'API', isAcronym: true }
    ])
  })
})

describe('GlossaryTermDialog - canonical page path (OpenProject #1112)', () => {
  it('resolves a valid path and shows the found page title', async () => {
    API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ id: 'page-1', title: 'API Docs', path: 'dev/api' })
    })
    const wrapper = mountDialog()

    wrapper.vm.state.path = 'dev/api'
    await wrapper.vm.checkPath()

    expect(wrapper.vm.state.pathStatus).toBe('valid')
    expect(wrapper.vm.state.pathPageTitle).toBe('API Docs')
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/1a427132045c5e')
  })

  it('marks an unresolvable path invalid, without blocking the field', async () => {
    API_CLIENT.get.mockReturnValue({ json: () => Promise.reject(new Error('not found')) })
    const wrapper = mountDialog()

    wrapper.vm.state.path = 'does/not/exist'
    await wrapper.vm.checkPath()

    expect(wrapper.vm.state.pathStatus).toBe('invalid')
  })

  it('resets to empty when the path is cleared, without a network call', async () => {
    const wrapper = mountDialog()
    wrapper.vm.state.path = ''

    await wrapper.vm.checkPath()

    expect(wrapper.vm.state.pathStatus).toBe('empty')
  })
})
