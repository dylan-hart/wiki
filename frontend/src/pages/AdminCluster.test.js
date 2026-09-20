import { describe, expect, it } from 'vitest'

import AdminCluster from './AdminCluster.vue'
import WTable from '@/components/shared/WTable.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * Vue's keyed diff only compares keys that are `!= null` (`runtime-core`'s `patchKeyedChildren`), so
 * a `row-key` naming a field no row has degrades silently to positional patching — no dev-mode
 * duplicate-key warning to assert on, hence the assertion on `rowKey` itself.
 */
function mountPage() {
  return mountWithApp(AdminCluster, {
    messages: {
      'admin.cluster.title': 'Cluster',
      'admin.cluster.subtitle': 'Connected cluster nodes',
      'admin.cluster.activeConnections': 'Connections',
      'admin.cluster.activeListeners': 'Listeners',
      'admin.cluster.firstSeen': 'First seen',
      'admin.cluster.lastSeen': 'Last seen',
      'common.field.id': 'ID',
      'common.actions.viewDocs': 'View docs',
      'common.actions.refresh': 'Refresh'
    }
  }).wrapper
}

const NODE_A = {
  id: 'aaaaaaaaaa',
  activeConnections: 1,
  activeListeners: 1,
  dbUser: 'wiki',
  dbFirstSeen: '2026-08-17T00:00:00.000Z',
  dbLastSeen: '2026-08-17T00:05:00.000Z',
  ip: '127.0.0.1'
}
const NODE_B = {
  id: 'bbbbbbbbbb',
  activeConnections: 2,
  activeListeners: 1,
  dbUser: 'wiki',
  dbFirstSeen: '2026-08-17T00:01:00.000Z',
  dbLastSeen: '2026-08-17T00:06:00.000Z',
  ip: '127.0.0.2'
}

describe('AdminCluster table', () => {
  it('keys rows on "id", the one identity property cluster nodes actually have', () => {
    const wrapper = mountPage()
    expect(wrapper.findComponent(WTable).props('rowKey')).toBe('id')
    wrapper.unmount()
  })

  it('renders zero nodes without error', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.state.nodes).toEqual([])
    expect(wrapper.findAll('tbody tr').length).toBe(0)

    wrapper.unmount()
  })

  it('renders a single node', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([NODE_A]) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('tbody tr').length).toBe(1)
    expect(wrapper.text()).toContain('aaaaaaaaaa')

    wrapper.unmount()
  })

  it('renders multiple nodes, each with its own row and identity', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([NODE_A, NODE_B]) })

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

// -> Cluster monitoring is a fork-invented surface, so no docs site describes it: a help button here
//    would point at a page that does not exist.
describe('AdminCluster help link', () => {
  it('has no help/docs button', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.html()).not.toContain('/admin/cluster')

    wrapper.unmount()
  })
})
