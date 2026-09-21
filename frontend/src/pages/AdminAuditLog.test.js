import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileSave } from 'browser-fs-access'

import AdminAuditLog from './AdminAuditLog.vue'

import { queue as notifyQueue } from '@/composables/notify'

import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

vi.mock('browser-fs-access', () => ({ fileSave: vi.fn() }))

function mountPage({ permissions = ['manage:system'] } = {}) {
  return mountWithApp(AdminAuditLog, {
    stores: { user: { permissions } },
    messages: {
      'admin.audit.title': 'Audit Log',
      'admin.audit.event.user.created': 'User Created',
      'admin.audit.none': 'No audit events recorded yet.',
      'admin.audit.exportNdjson': 'Export NDJSON',
      'admin.audit.exportFailed': 'Failed to export the audit log.',
      'admin.audit.retentionTitle': 'Retention',
      'admin.audit.retentionSubtitle': 'Entries older than this are trimmed automatically.',
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
  beforeEach(() => {
    fileSave.mockReset()
    notifyQueue.splice(0)
  })

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

    const header = wrapper.find('.admin-page-header')
    expect(header.text()).not.toContain('Save')

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

  it("renders the table's #no-data slot message when there are no entries (OpenProject #2061)", async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'audit-log') {
        return { json: () => Promise.resolve({ total: 0, limit: 50, offset: 0, entries: [] }) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const wrapper = mountPage()
    await flush(wrapper)

    expect(wrapper.vm.state.entries).toHaveLength(0)
    expect(wrapper.text()).toContain('No audit events recorded yet.')

    wrapper.unmount()
  })

  it('aligns the retention Save button on items-center, not items-end (OpenProject #2331)', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve(undefined) }))

    const wrapper = mountPage()
    await flush(wrapper)

    // The days input carries `:rules`, so `w-input` reserves a hint/error row below its visible
    // box -- `items-end` would align the button to the bottom of that reserved area rather than
    // to the visible field.
    const row = wrapper.find('.retention-actions')
    expect(row.exists()).toBe(true)
    expect(row.classes()).toContain('items-center')
    expect(row.classes()).not.toContain('items-end')

    wrapper.unmount()
  })

  /**
   * The log table takes no settings row: it is a data-driven collection whose rows carry an event,
   * an actor, a target, a detail blob and a date, none of which fit a label/hint/control triple.
   */
  it('draws the retention setting as a settings row and leaves the log table alone', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'audit-log/settings') {
        return { json: () => Promise.resolve({ retentionDays: 180 }) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const wrapper = mountPage()
    await flush(wrapper)

    const rows = wrapper.findAll('.w-settings-row')
    expect(rows).toHaveLength(1)

    const retention = rows[0]
    expect(retention.find('.blueprint-icon').exists()).toBe(true)
    expect(retention.find('.w-settings-row__label').text()).toBe('Retention')
    expect(retention.find('.w-settings-row__hint').text()).toBe(
      'Entries older than this are trimmed automatically.'
    )
    const control = retention.find('.w-settings-row__control')
    expect(control.find('input[type="number"]').exists()).toBe(true)
    expect(control.text()).toContain('Save')
    expect(wrapper.find('.retention-actions').exists()).toBe(true)

    // -> A single-purpose card whose one row names itself needs no heading strip above it.
    expect(wrapper.find('.text-subtitle1').exists()).toBe(false)
    expect(wrapper.findAll('.w-section-header')).toHaveLength(0)

    wrapper.unmount()
  })

  it('hides the retention card and never loads the setting without manage:system', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve(undefined) }))

    const wrapper = mountPage({ permissions: ['read:audit'] })
    await flush(wrapper)

    expect(wrapper.find('.w-settings-row').exists()).toBe(false)
    expect(wrapper.find('.retention-save-btn').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Retention')
    expect(API_CLIENT.get.mock.calls.map(([url]) => url)).not.toContain('audit-log/settings')
    expect(API_CLIENT.get.mock.calls.map(([url]) => url)).toContain('audit-log')

    wrapper.unmount()
  })

  it('loads the retention setting for a manage:system reader', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve(undefined) }))

    const wrapper = mountPage()
    await flush(wrapper)

    expect(API_CLIENT.get.mock.calls.map(([url]) => url)).toContain('audit-log/settings')
    expect(wrapper.find('.retention-save-btn').exists()).toBe(true)

    wrapper.unmount()
  })

  it('exportNdjson() fetches the unpaged, filtered export and saves it as a dated .ndjson file', async () => {
    const blob = new Blob(['{}\n'])
    API_CLIENT.get.mockImplementation((url) =>
      url === 'audit-log/export'
        ? { blob: () => Promise.resolve(blob) }
        : { json: () => Promise.resolve(undefined) }
    )
    fileSave.mockResolvedValue(undefined)

    const wrapper = mountPage({ permissions: ['read:audit'] })
    await flush(wrapper)

    wrapper.vm.state.filters.actorId = 'user-1'
    wrapper.vm.state.filters.event = 'user.created'
    API_CLIENT.get.mockClear()

    const exportBtn = wrapper.findAll('button').find((b) => b.text().includes('Export NDJSON'))
    expect(exportBtn).toBeDefined()
    await exportBtn.trigger('click')
    await flush(wrapper)

    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
    const [url, opts] = API_CLIENT.get.mock.calls[0]
    expect(url).toBe('audit-log/export')
    expect(opts.searchParams.get('actorId')).toBe('user-1')
    expect(opts.searchParams.get('event')).toBe('user.created')
    expect(opts.searchParams.has('limit')).toBe(false)
    expect(opts.searchParams.has('offset')).toBe(false)

    expect(fileSave).toHaveBeenCalledTimes(1)
    const [saved, saveOpts] = fileSave.mock.calls[0]
    expect(saved).toBe(blob)
    expect(saveOpts.fileName).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.ndjson$/)
    expect(saveOpts.extensions).toEqual(['.ndjson'])
    expect(wrapper.vm.state.exporting).toBe(false)
    expect(notifyQueue).toHaveLength(0)

    wrapper.unmount()
  })

  it('exportNdjson() notifies when the export request fails', async () => {
    API_CLIENT.get.mockImplementation((url) =>
      url === 'audit-log/export'
        ? { blob: () => Promise.reject(new Error('boom')) }
        : { json: () => Promise.resolve(undefined) }
    )

    const wrapper = mountPage({ permissions: ['read:audit'] })
    await flush(wrapper)

    await wrapper.vm.exportNdjson()

    expect(fileSave).not.toHaveBeenCalled()
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Failed to export the audit log.'
    })
    expect(wrapper.vm.state.exporting).toBe(false)

    wrapper.unmount()
  })

  it('exportNdjson() stays silent when the user cancels the save dialog', async () => {
    API_CLIENT.get.mockImplementation((url) =>
      url === 'audit-log/export'
        ? { blob: () => Promise.resolve(new Blob([])) }
        : { json: () => Promise.resolve(undefined) }
    )
    fileSave.mockRejectedValue(new DOMException('cancelled', 'AbortError'))

    const wrapper = mountPage({ permissions: ['read:audit'] })
    await flush(wrapper)

    await wrapper.vm.exportNdjson()

    expect(fileSave).toHaveBeenCalledTimes(1)
    expect(notifyQueue).toHaveLength(0)
    expect(wrapper.vm.state.exporting).toBe(false)

    wrapper.unmount()
  })
})
