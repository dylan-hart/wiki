import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import InboxLayout from './InboxLayout.vue'
import { useUserStore } from '@/stores/user'

/**
 * Regression coverage for OpenProject #2000: the rail used to have a first "Inbox" entry pointing at
 * `/_inbox/messages` (an entirely static stub, deleted alongside this) and a separate "Watching" entry
 * pointing at `/_inbox/watching` (the actual notification list). With `messages` gone, the first entry
 * is repointed at `watching` instead of being left dangling -- which also means the old, now-redundant
 * second entry for the same page is gone, not duplicated alongside it.
 */

const messages = {
  en: {
    inbox: {
      title: 'Inbox',
      inbox: 'Inbox',
      pendingReview: 'Pending Review'
    }
  }
}

async function mountInboxLayout() {
  setActivePinia(createPinia())
  const userStore = useUserStore()
  userStore.$patch({ authenticated: true })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', component: { template: '<div />' } },
      { path: '/_inbox/:path(.*)', component: { template: '<router-view />' } }
    ]
  })
  router.push('/_inbox/watching')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages })

  return mount(InboxLayout, {
    global: {
      plugins: [router, i18n],
      stubs: {
        HeaderNav: true,
        MainOverlayDialog: true
      }
    }
  })
}

describe('InboxLayout sidenav', () => {
  it('renders exactly two rail entries, not three', async () => {
    const wrapper = await mountInboxLayout()

    expect(wrapper.vm.sidenav).toHaveLength(2)
  })

  it('repoints the first entry at /_inbox/watching instead of the deleted /_inbox/messages', async () => {
    const wrapper = await mountInboxLayout()

    const firstItem = wrapper.vm.sidenav[0]
    expect(firstItem.key).toBe('watching')
    expect(firstItem.label).toBe('Inbox')
  })

  it('does not duplicate a second entry for the watching page', async () => {
    const wrapper = await mountInboxLayout()

    const watchingEntries = wrapper.vm.sidenav.filter((item) => item.key === 'watching')
    expect(watchingEntries).toHaveLength(1)
  })

  it('keeps the pending-review entry as the second item', async () => {
    const wrapper = await mountInboxLayout()

    expect(wrapper.vm.sidenav[1].key).toBe('review')
  })
})
