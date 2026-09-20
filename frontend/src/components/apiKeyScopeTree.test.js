import { afterEach, describe, expect, it } from 'vitest'
import { DOMWrapper } from '@vue/test-utils'

import ApiKeyCreateDialog from './ApiKeyCreateDialog.vue'
import ProfileApiKeyCreateDialog from './ProfileApiKeyCreateDialog.vue'

import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * The "mixed group checkbox, then the narrowed list on create" assertion stays in each dialog's own
 * suite rather than moving here: the two POST different bodies (the admin form carries `groups`, the
 * profile form does not), which is the thing that assertion exists to pin down.
 *
 * Both dialogs opt out of the default `teleport: true` stub, since `w-dialog` really teleports its
 * body to `document.body` -- which is where every lookup below reads.
 */
const DIALOGS = [
  ['ApiKeyCreateDialog', ApiKeyCreateDialog],
  ['ProfileApiKeyCreateDialog', ProfileApiKeyCreateDialog]
]

function body() {
  return new DOMWrapper(document.body)
}

function groupCheckbox(verb) {
  return body().find(`[role="checkbox"][aria-label="${verb}"]`)
}

function groupToggleButton(verb) {
  return [...body().findAll('.api-key-scope-picker__group-toggle')].find((btn) =>
    btn.text().startsWith(verb)
  )
}

function leafCheckbox(scope) {
  return [...body().findAll('[role="checkbox"]')].find((el) => el.text().includes(scope))
}

describe.each(DIALOGS)('%s scope tree', (_name, Dialog) => {
  /*
    Every dialog teleports into `document.body` and nothing takes it back out on its own, so with a
    second one live the first one's checkboxes stay the FIRST match for every lookup above and the
    clicks land on a wrapper the test is no longer asserting against.
  */
  let mounted = null

  afterEach(() => {
    mounted?.unmount()
    mounted = null
  })

  async function mountDialog() {
    stubApi({}, { fallback: [] })
    const { wrapper } = mountWithApp(Dialog, { stubs: {} })
    mounted = wrapper
    await new Promise((resolve) => setTimeout(resolve, 0))
    return wrapper
  }

  it('renders the closed scope vocabulary as one group per verb, including a single-member group', async () => {
    await mountDialog()

    expect(groupCheckbox('manage').exists()).toBe(true)
    expect(groupCheckbox('read').exists()).toBe(true)
    expect(groupCheckbox('review').exists()).toBe(true)
  })

  it('toggling one leaf scope checkbox narrows keyScope to just that scope', async () => {
    const wrapper = await mountDialog()

    await groupToggleButton('manage').trigger('click')
    await leafCheckbox('manage:users').trigger('click')

    expect(wrapper.vm.state.keyScope).toEqual(['manage:users'])
  })

  it('clicking a group checkbox selects every scope in that group, and a second click deselects them', async () => {
    const wrapper = await mountDialog()

    await groupCheckbox('read').trigger('click')
    expect(wrapper.vm.state.keyScope).toEqual(
      expect.arrayContaining([
        'read:pages',
        'read:source',
        'read:history',
        'read:assets',
        'read:comments'
      ])
    )
    expect(groupCheckbox('read').attributes('aria-checked')).toBe('true')

    await groupCheckbox('read').trigger('click')
    expect(wrapper.vm.state.keyScope).toEqual([])
  })
})
