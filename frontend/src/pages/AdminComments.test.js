import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import AdminComments from './AdminComments.vue'

/**
 * Smoke test standing in for the manual browser check Task 614 asks for (Feature 394, "Admin
 * comments management UI rebuild"): following the sidebar link must land on a rendering page, not a
 * blank/error one. There is no browser-automation tool available to this run, so this proves the
 * same thing at the component level -- the page mounts and paints its header without throwing.
 *
 * It does NOT claim the page is fully rebuilt: `AdminComments.vue` still uses the pre-3.x Vuetify
 * tags and the removed Apollo/`$store` plumbing (see CLAUDE.md's "GraphQL is being removed"
 * section), both out of scope for this routing-only task. `mount()` throwing here is exactly the
 * failure this task's own acceptance bar rules out; two genuine blockers of that kind were found and
 * fixed as part of this change -- a `<template v-for>` key that Vue 3 requires on the `<template>`
 * tag itself (a hard SyntaxError from the SFC compiler) and an unresolvable `import _ from 'lodash'`
 * (a dependency neither `lodash` nor `lodash-es` had ever been added to `frontend/package.json`).
 */
describe('AdminComments', () => {
  it('mounts and renders its header without throwing', () => {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

    const wrapper = mount(AdminComments, {
      global: { plugins: [i18n] }
    })

    expect(wrapper.find('.admin-header-title').exists()).toBe(true)
  })
})
