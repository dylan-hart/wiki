import { afterEach, describe, expect, it } from 'vitest'
import { DOMWrapper, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import BlueprintIcon from './BlueprintIcon.vue'
import ProfileApiKeyCreateDialog from './ProfileApiKeyCreateDialog.vue'

afterEach(() => {
  document.body.innerHTML = ''
})

/**
 * OpenProject #788: the self-service counterpart to `ApiKeyCreateDialog.vue`, minus the groups
 * picker -- a personal token always carries the creating user's own current permissions, so there is
 * nothing to pick there, only the `scope`/`siteId` narrowing every admin-issued key also gets.
 *
 * A fresh pinia per mount, same as `ApiKeyCreateDialog.test.js`: the dialog reads classification
 * levels off `adminStore.classificationLevels` (OpenProject #1205's checkbox grid replaced the
 * dialog's own independent fetch), populated by `adminStore.fetchClassificationLevels()` in
 * `onMounted` -- which still goes through the same `API_CLIENT.get('classification-levels')` mock
 * these tests already set up.
 */
function mountDialog() {
  setActivePinia(createPinia())
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
  return mount(ProfileApiKeyCreateDialog, {
    global: {
      plugins: [i18n],
      components: { BlueprintIcon }
    }
  })
}

describe('ProfileApiKeyCreateDialog', () => {
  it('posts to users/profile/api-keys with no groups field, unlike the admin-issued form', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'sites') {
        return { json: () => Promise.resolve([{ id: 'site-1', title: 'Docs' }]) }
      }
      return { json: () => Promise.resolve([]) }
    })
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    wrapper.vm.state.keyName = 'My Token'
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'users/profile/api-keys',
      expect.objectContaining({
        json: {
          name: 'My Token',
          expiration: '90d',
          scope: null,
          allowedClassifications: null,
          siteId: null
        }
      })
    )
  })

  it('prepends an "All Sites" (id: null) entry to the fetched sites list, same as the admin form', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'sites') {
        return { json: () => Promise.resolve([{ id: 'site-1', title: 'Docs' }]) }
      }
      return { json: () => Promise.resolve([]) }
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.vm.siteOptions).toEqual([
      { id: null, title: 'profile.api.newKeySiteAllSites' },
      { id: 'site-1', title: 'Docs' }
    ])
  })

  it('sends a non-empty scope selection as the narrowing list, not null', async () => {
    globalThis.API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    wrapper.vm.state.keyName = 'My Token'
    wrapper.vm.state.keyScope = ['read:pages']
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'users/profile/api-keys',
      expect.objectContaining({ json: expect.objectContaining({ scope: ['read:pages'] }) })
    )
  })

  /**
   * OpenProject #1205: the checkbox grid that replaced the single-select "ceiling" -- every fetched
   * level starts checked, which is what makes the default equivalent to the old "No Limit".
   */
  it('defaults every fetched classification level to checked', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'classification-levels') {
        return {
          json: () =>
            Promise.resolve([
              { id: 'level-public', name: 'Public', sortOrder: 0 },
              { id: 'level-restricted', name: 'Restricted', sortOrder: 1 }
            ])
        }
      }
      return { json: () => Promise.resolve([]) }
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.vm.state.keyClassifications).toEqual(['level-public', 'level-restricted'])
  })

  it('sends the explicit checked ids as allowedClassifications once a level is unchecked', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'classification-levels') {
        return {
          json: () =>
            Promise.resolve([
              { id: 'level-public', name: 'Public', sortOrder: 0 },
              { id: 'level-restricted', name: 'Restricted', sortOrder: 1 }
            ])
        }
      }
      return { json: () => Promise.resolve([]) }
    })
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    wrapper.vm.state.keyName = 'My Token'
    // -> Uncheck "Public", leaving only "Restricted" checked
    wrapper.vm.state.keyClassifications = ['level-restricted']
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'users/profile/api-keys',
      expect.objectContaining({
        json: expect.objectContaining({ allowedClassifications: ['level-restricted'] })
      })
    )
  })
})

/**
 * OpenProject #1272: the same verb-grouped tri-state scope tree (`ApiKeyScopePicker.vue`) as
 * `ApiKeyCreateDialog.vue`'s admin form, replacing the earlier flat `w-select multiple use-chips`
 * field here too. `wrapper.vm.state.keyScope` is still a flat array of scope strings -- the picker
 * only changed the UI reaching it, not the wire shape.
 *
 * `WDialog` renders its content behind a `<teleport to="body">`, which lands it as a real child of
 * `document.body`, outside `@vue/test-utils`'s own tracked tree -- `wrapper.find()` never sees it.
 * Every query below goes through the real DOM instead, via a `DOMWrapper(document.body)` -- same
 * pattern `ApiKeyCreateDialog.test.js`'s own scope-tree suite uses.
 */
describe('ProfileApiKeyCreateDialog scope tree', () => {
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

  it('renders the closed scope vocabulary as one group per verb, including a single-member group', async () => {
    globalThis.API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(groupCheckbox('manage').exists()).toBe(true)
    expect(groupCheckbox('read').exists()).toBe(true)
    expect(groupCheckbox('review').exists()).toBe(true)
  })

  it('toggling one leaf scope checkbox narrows keyScope to just that scope', async () => {
    globalThis.API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    await groupToggleButton('manage').trigger('click')
    await leafCheckbox('manage:users').trigger('click')

    expect(wrapper.vm.state.keyScope).toEqual(['manage:users'])
  })

  it('clicking a group checkbox selects every scope in that group, and a second click deselects them', async () => {
    globalThis.API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

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

  it('shows the group checkbox as mixed once only some of its scopes are checked, and sends the narrowed list on create', async () => {
    globalThis.API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })
    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    await groupToggleButton('read').trigger('click')
    await leafCheckbox('read:pages').trigger('click')

    expect(groupCheckbox('read').attributes('aria-checked')).toBe('mixed')

    wrapper.vm.state.keyName = 'My Token'
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'users/profile/api-keys',
      expect.objectContaining({ json: expect.objectContaining({ scope: ['read:pages'] }) })
    )
  })
})
