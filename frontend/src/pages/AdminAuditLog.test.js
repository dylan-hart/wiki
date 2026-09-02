import { describe, expect, it } from 'vitest'

import AdminAuditLog from './AdminAuditLog.vue'

import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * OpenProject #989: the instance-wide audit log's admin list — filtering by actor/type/date, and the
 * retention setting saved alongside it.
 */
function mountPage() {
  return mountWithApp(AdminAuditLog, {
    messages: {
      'admin.audit.title': 'Audit Log',
      'admin.audit.event.user.created': 'User Created',
      'common.actions.save': 'Save'
    }
  }).wrapper
}

async function flush(wrapper) {
  await wrapper.vm.$nextTick()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

describe('AdminAuditLog', () => {
  it('loads entries, actors and the retention setting on mount', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'audit-log') {
        return {
          json: () =>
            Promise.resolve({
              total: 1,
              limit: 50,
              offset: 0,
              entries: [
                {
                  id: 'entry-1',
                  event: 'user.created',
                  actor: { id: 'user-1', name: 'Jane Doe' },
                  actorIp: '203.0.113.5',
                  targetType: 'user',
                  targetId: 'user-2',
                  targetLabel: 'new@example.com',
                  detail: {},
                  siteId: null,
                  createdAt: '2026-08-21T12:00:00.000Z'
                }
              ]
            })
        }
      }
      if (url === 'audit-log/actors') {
        return { json: () => Promise.resolve([{ id: 'user-1', name: 'Jane Doe' }]) }
      }
      if (url === 'audit-log/settings') {
        return { json: () => Promise.resolve({ retentionDays: 180 }) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const wrapper = mountPage()
    await flush(wrapper)

    expect(wrapper.vm.state.entries).toHaveLength(1)
    expect(wrapper.vm.state.total).toBe(1)
    expect(wrapper.vm.state.retentionDays).toBe(180)
    expect(wrapper.text()).toContain('new@example.com')
    expect(wrapper.text()).toContain('User Created')

    wrapper.unmount()
  })

  it('reload() sends the actor/event/date filters as querystring params', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve(undefined) }))

    const wrapper = mountPage()
    await flush(wrapper)

    wrapper.vm.state.filters.actorId = 'user-1'
    wrapper.vm.state.filters.event = 'user.created'
    wrapper.vm.state.filters.from = '2026-01-01'
    wrapper.vm.state.filters.to = '2026-01-31'

    API_CLIENT.get.mockClear()
    await wrapper.vm.reload()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
    const [url, opts] = API_CLIENT.get.mock.calls[0]
    expect(url).toBe('audit-log')
    expect(opts.searchParams.get('actorId')).toBe('user-1')
    expect(opts.searchParams.get('event')).toBe('user.created')
    expect(opts.searchParams.get('from')).toBe('2026-01-01T00:00:00.000Z')
    expect(opts.searchParams.get('to')).toBe('2026-01-31T23:59:59.999Z')

    wrapper.unmount()
  })

  it('resetFilters() clears every filter and reloads', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve(undefined) }))

    const wrapper = mountPage()
    await flush(wrapper)

    wrapper.vm.state.filters.actorId = 'user-1'
    wrapper.vm.state.filters.event = 'user.created'
    wrapper.vm.state.filters.from = '2026-01-01'
    wrapper.vm.state.filters.to = '2026-01-31'

    wrapper.vm.resetFilters()
    await flush(wrapper)

    expect(wrapper.vm.state.filters).toEqual({ actorId: null, event: null, from: '', to: '' })

    wrapper.unmount()
  })

  it('saveRetention() PUTs the edited value to audit-log/settings', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve(undefined) }))
    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, message: 'Audit log retention setting updated.' })
    })

    const wrapper = mountPage()
    await flush(wrapper)

    wrapper.vm.state.retentionDays = 90
    await wrapper.vm.saveRetention()

    expect(API_CLIENT.put).toHaveBeenCalledWith('audit-log/settings', {
      json: { retentionDays: 90 }
    })

    wrapper.unmount()
  })

  it('saveRetention() rejects an out-of-range value client-side, without hitting the API', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve(undefined) }))

    const wrapper = mountPage()
    await flush(wrapper)

    wrapper.vm.state.retentionDays = 0
    await wrapper.vm.$nextTick()
    await wrapper.vm.saveRetention()

    expect(API_CLIENT.put).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('commits the retention setting from its own card-local Save button, not a page-header action (OpenProject #2089)', async () => {
    stubApi({ 'audit-log/settings': { retentionDays: 180 } })
    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, message: 'Audit log retention setting updated.' })
    })

    const wrapper = mountPage()
    await flush(wrapper)

    // The page header carries only view-docs/refresh actions -- no Apply/Save button lives there.
    const header = wrapper.find('.flex.flex-wrap.p-4.items-center')
    expect(header.text()).not.toContain('Save')

    // The retention setting commits from its own in-card button instead.
    wrapper.vm.state.retentionDays = 90
    const saveBtn = wrapper.find('.retention-save-btn')
    expect(saveBtn.exists()).toBe(true)

    await saveBtn.trigger('click')
    await flush(wrapper)

    expect(API_CLIENT.put).toHaveBeenCalledWith('audit-log/settings', {
      json: { retentionDays: 90 }
    })

    wrapper.unmount()
  })

  it('aligns the retention Save button on items-center, not items-end (OpenProject #2331)', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve(undefined) }))

    const wrapper = mountPage()
    await flush(wrapper)

    // The days input carries `:rules`, so `w-input` reserves a hint/error row below its visible
    // box -- `items-end` would align the button to the bottom of that whole reserved area rather
    // than the visible field, throwing off the alignment this row is meant to read as one row.
    const row = wrapper.find('.retention-actions')
    expect(row.exists()).toBe(true)
    expect(row.classes()).toContain('items-center')
    expect(row.classes()).not.toContain('items-end')

    wrapper.unmount()
  })
})
