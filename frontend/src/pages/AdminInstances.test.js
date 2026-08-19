import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminInstances from './AdminInstances.vue'
import WTable from '@/components/shared/WTable.vue'

/**
 * Task 605 verification pass.
 *
 * `<w-table row-key="name">` was wired to a property no row object has — see `getInstances()` in
 * `backend/api/system.ts`, which returns `id`/`activeConnections`/`dbUser`/... with no `name` field
 * at all. Every row therefore keyed on the same `undefined`.
 *
 * That is a real bug of intent (the prop's own docstring says it wants "a row property holding a
 * stable identity"), but it is NOT a duplicate-key warning: Vue's keyed-diff algorithm only compares
 * keys that are `!= null` (`runtime-core`'s `patchKeyedChildren`), so an `undefined` key is treated as
 * "no key" and the row falls back to positional patching rather than tripping the dev-mode duplicate
 * check — confirmed by running this suite against the unfixed `row-key="name"` and observing it stays
 * green either way. So this suite does not assert on a console warning (there isn't one); it asserts
 * on the fix itself (the prop now names a field that exists) and on the table rendering sensibly at
 * zero, one, and multiple rows, which is the actual behavior the task asked to be confirmed.
 */
function mountPage() {
  setActivePinia(createPinia())

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        'admin.instances.title': 'Instances',
        'admin.instances.subtitle': 'Connected instances',
        'admin.instances.activeConnections': 'Connections',
        'admin.instances.activeListeners': 'Listeners',
        'admin.instances.firstSeen': 'First seen',
        'admin.instances.lastSeen': 'Last seen',
        'common.field.id': 'ID',
        'common.actions.viewDocs': 'View docs',
        'common.actions.refresh': 'Refresh'
      }
    }
  })

  return mount(AdminInstances, {
    global: {
      plugins: [i18n]
    }
  })
}

const INSTANCE_A = {
  id: 'aaaaaaaaaa',
  activeConnections: 1,
  activeListeners: 1,
  dbUser: 'wiki',
  dbFirstSeen: '2026-08-17T00:00:00.000Z',
  dbLastSeen: '2026-08-17T00:05:00.000Z',
  ip: '127.0.0.1'
}
const INSTANCE_B = {
  id: 'bbbbbbbbbb',
  activeConnections: 2,
  activeListeners: 1,
  dbUser: 'wiki',
  dbFirstSeen: '2026-08-17T00:01:00.000Z',
  dbLastSeen: '2026-08-17T00:06:00.000Z',
  ip: '127.0.0.2'
}

describe('AdminInstances table', () => {
  it('keys rows on "id", the one identity property instances actually have', () => {
    const wrapper = mountPage()
    expect(wrapper.findComponent(WTable).props('rowKey')).toBe('id')
    wrapper.unmount()
  })

  it('renders zero instances without error', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.state.instances).toEqual([])
    expect(wrapper.findAll('tbody tr').length).toBe(0)

    wrapper.unmount()
  })

  it('renders a single instance', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([INSTANCE_A]) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('tbody tr').length).toBe(1)
    expect(wrapper.text()).toContain('aaaaaaaaaa')

    wrapper.unmount()
  })

  it('renders multiple instances, each with its own row and identity', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([INSTANCE_A, INSTANCE_B]) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('tbody tr').length).toBe(2)
    expect(wrapper.text()).toContain('aaaaaaaaaa')
    expect(wrapper.text()).toContain('bbbbbbbbbb')
    expect(wrapper.text()).toContain('127.0.0.1')
    expect(wrapper.text()).toContain('127.0.0.2')

    wrapper.unmount()
  })
})
