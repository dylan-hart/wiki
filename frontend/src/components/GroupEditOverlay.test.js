import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import GroupEditOverlay from './GroupEditOverlay.vue'
import { useAdminStore } from '@/stores/admin'

/**
 * Task #684: `GroupEditOverlay.vue`'s rule editor is extended to offer the eight `site:*` site-admin
 * permissions (see `backend/helpers/siteRules.ts`'s `SITE_PERMISSIONS`) as selectable `roles` entries
 * in the SAME picker page permissions already use, rather than a second UI -- per the decision record
 * at `docs/decisions/delegated-per-site-administration.md`.
 *
 * Mounted at the `rules` section for a non-guest group whose one rule already holds all eight
 * `site:*` permissions in `roles` -- exactly the shape a saved group would come back as. The
 * `#selected-item` template renders each held role as a chip labelled with its catalog `title`, so a
 * permission string missing from (or misspelled in) the catalog array this test guards would either
 * render no chip for it or a blank one, not the expected title text.
 */
const SITE_PERMISSION_TITLES = {
  'site:general': 'Site: General Settings',
  'site:theme': 'Site: Theme',
  'site:navigation': 'Site: Navigation',
  'site:blocks': 'Site: Blocks',
  'site:approvals': 'Site: Approval Rules',
  'site:login': 'Site: Login & Authentication',
  'site:locale': 'Site: Locale',
  'site:editors': 'Site: Editors'
}

async function mountRulesSection(groupId) {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.overlayOpts = { id: groupId }
  adminStore.sites = []
  adminStore.locales = []

  API_CLIENT.get.mockReturnValueOnce({
    json: () =>
      Promise.resolve({
        id: groupId,
        name: 'Test Group',
        userCount: 0,
        permissions: [],
        rules: [
          {
            id: 'rule-1',
            name: 'Site admin rule',
            mode: 'ALLOW',
            roles: Object.keys(SITE_PERMISSION_TITLES),
            sites: [],
            match: 'START',
            path: '',
            locales: []
          }
        ]
      })
  })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:section', component: { template: '<div />' } }]
  })
  router.push(`/rules`)
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(GroupEditOverlay, {
    global: {
      plugins: [router, i18n]
    }
  })
  await flushPromises()

  return wrapper
}

describe('GroupEditOverlay rule editor: site: permission vocabulary', () => {
  it('renders every site: permission held by a rule with its catalog title', async () => {
    const wrapper = await mountRulesSection('11111111-1111-4111-8111-111111111111')

    const text = wrapper.text()
    for (const title of Object.values(SITE_PERMISSION_TITLES)) {
      expect(text).toContain(title)
    }
  })
})
