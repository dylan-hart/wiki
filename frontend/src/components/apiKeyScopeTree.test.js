import { afterEach, describe, expect, it } from 'vitest'
import { DOMWrapper } from '@vue/test-utils'

import ApiKeyCreateDialog from './ApiKeyCreateDialog.vue'
import ProfileApiKeyCreateDialog from './ProfileApiKeyCreateDialog.vue'

import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * The scope picker is one component (`components/shared/`-adjacent markup inside both dialogs) driven
 * by one closed vocabulary (`helpers/apiKeyScopes.js`), so how it groups, toggles and narrows is the
 * same claim about both the admin-issued and the profile-issued key form. Three assertions about it
 * were byte-identical between `ApiKeyCreateDialog.test.js` and `ProfileApiKeyCreateDialog.test.js`
 * (TEST-F13.9); they live once here, as a `describe.each` over the two dialogs, so both are still
 * exercised and each still reports under its own component's name.
 *
 * The fourth scope-tree assertion in each suite -- "shows the group checkbox as mixed ... and sends
 * the narrowed list on create" -- is NOT shared: the two dialogs POST to different routes with
 * different bodies (the admin form carries `groups`, the profile form does not), which is exactly the
 * thing that assertion exists to pin down. It stays in each suite.
 *
 * Both dialogs opt out of `mountWithApp`'s default `teleport: true` stub, since `w-dialog` really
 * teleports its body to `document.body` -- which is where every lookup below reads.
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
    Every dialog here teleports into `document.body` and nothing takes it back out on its own, so a
    second mount would leave the first one's checkboxes as the FIRST match for every lookup above --
    the clicks would land on a wrapper the test is no longer asserting against. Unmounting is what
    keeps each test looking at its own dialog; the two suites this was lifted from mounted once per
    test and never had two live at the same time.
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
    // -> `review:pages` is the only `review:*` scope today -- still its own group, not folded away
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
