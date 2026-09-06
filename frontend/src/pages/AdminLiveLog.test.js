import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mountWithApp } from '../../test/mount.js'
import AdminLiveLog from './AdminLiveLog.vue'

/**
 * OpenProject #2680 — the Live Log page that replaced the xterm-backed Terminal.
 *
 * The socket is faked rather than stubbed away: the page's whole job is to turn a stream of
 * `LogFrame`s into filterable rows, and that stream only exists once a `WebSocket` has opened, sent
 * its handshake and started delivering frames. `FakeSocket` below is the smallest thing that lets a
 * test drive those four events (`open`, handshake `message`, frame `message`, `close`) in the order
 * a real server produces them, so every assertion here runs against the same code path production
 * does — including the 4000-range refusal branch, which has no other way in.
 */

const SRC_ROOT = dirname(fileURLToPath(import.meta.url))
const LOCALES_PATH = join(SRC_ROOT, '../../../backend/locales/en.json')
const PAGE_PATH = join(SRC_ROOT, 'AdminLiveLog.vue')

/** Every `admin.liveLog.*` string the assertions below read, taken from the real catalogue. */
const localeCatalogue = JSON.parse(readFileSync(LOCALES_PATH, 'utf-8'))
const messages = Object.fromEntries(
  Object.entries(localeCatalogue).filter(([key]) => key.startsWith('admin.liveLog.'))
)

let sockets = []

class FakeSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.listeners = {}
    this.closed = null
    sockets.push(this)
  }

  addEventListener(type, fn) {
    ;(this.listeners[type] ??= []).push(fn)
  }

  close(code = 1000, reason = '') {
    this.closed = { code, reason }
  }

  emit(type, event) {
    for (const fn of this.listeners[type] ?? []) {
      fn(event)
    }
  }

  /** The three-step opening a real server performs, up to and including the handshake frame. */
  handshake(instance = 'inst-1') {
    this.readyState = 1
    this.emit('open', {})
    this.emit('message', { data: JSON.stringify({ instance }) })
  }

  frame(overrides = {}) {
    this.emit('message', {
      data: JSON.stringify({
        timestamp: '2026-09-06T09:15:04.512Z',
        instance: 'inst-1',
        level: 'info',
        scope: 'jobs',
        message: 'purgeUploads removed nothing',
        fields: {},
        ...overrides
      })
    })
  }
}

function mountPage(options = {}) {
  // -> A router only so `AdminPageEyebrow`'s `useRoute()` resolves; the page itself never navigates
  return mountWithApp(AdminLiveLog, {
    messages,
    routes: ['/_admin/livelog'],
    initialPath: '/_admin/livelog',
    ...options
  })
}

/** The rows the page has actually drawn, message text only. */
function renderedMessages(wrapper) {
  return wrapper.findAll('.admin-live-log-message').map((el) => el.text())
}

beforeEach(() => {
  sockets = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AdminLiveLog.vue', () => {
  it('opens the log websocket on mount and takes the instance from the handshake frame', async () => {
    const { wrapper } = mountPage()

    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toMatch(/\/_terminal\/logs$/)

    sockets[0].handshake('a1b2c3')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.admin-live-log-instance').text()).toBe('a1b2c3')
    // -> The handshake is not a log record and must not be drawn as one
    expect(renderedMessages(wrapper)).not.toContain('a1b2c3')
  })

  it('renders a received frame as a row of timestamp, level, scope, message and field chips', async () => {
    const { wrapper } = mountPage()
    sockets[0].handshake()
    sockets[0].frame({
      level: 'warn',
      scope: 'storage',
      message: 'git sync fell behind',
      fields: { module: 'git', behind: 4, ms: 528 }
    })
    await wrapper.vm.$nextTick()

    const row = wrapper.findAll('.admin-live-log-row').at(-1)
    expect(row.attributes('data-level')).toBe('warn')
    expect(row.attributes('data-scope')).toBe('storage')
    expect(row.find('.admin-live-log-time').text()).toBe('09:15:04.512')
    expect(row.find('.admin-live-log-level').text()).toBe('warn')
    expect(row.find('.admin-live-log-message').text()).toBe('git sync fell behind')

    const chips = row.findAll('.admin-live-log-chip').map((el) => el.text())
    // -> Same order the text renderer writes: fields as they came, then `ms` last
    expect(chips).toEqual(['module=git', 'behind=4', 'ms=528'])
  })

  it('renders an error field as its message, not as [object Object]', async () => {
    const { wrapper } = mountPage()
    sockets[0].handshake()
    sockets[0].frame({
      level: 'error',
      scope: 'db',
      message: 'query failed',
      fields: { error: { name: 'Error', message: 'connection refused', stack: 'Error: x\n  at y' } }
    })
    await wrapper.vm.$nextTick()

    const chips = wrapper
      .findAll('.admin-live-log-row')
      .at(-1)
      .findAll('.admin-live-log-chip')
      .map((el) => el.text())
    expect(chips).toEqual(['error=connection refused'])
  })

  it('hides debug rows once the level threshold is raised to info', async () => {
    const { wrapper } = mountPage()
    sockets[0].handshake()
    sockets[0].frame({ level: 'debug', message: 'storageSyncTick found nothing due' })
    sockets[0].frame({ level: 'info', message: 'purgeUploads removed 3 files' })
    await wrapper.vm.$nextTick()

    expect(renderedMessages(wrapper)).toContain('storageSyncTick found nothing due')

    const infoSegment = wrapper
      .findAll('[role="radio"]')
      .find((el) => el.text() === messages['admin.liveLog.levelInfo'])
    await infoSegment.trigger('click')

    const shown = renderedMessages(wrapper)
    expect(shown).not.toContain('storageSyncTick found nothing due')
    expect(shown).toContain('purgeUploads removed 3 files')
  })

  it('narrows to the picked scopes and offers every scope the stream has carried', async () => {
    // -> `stubs: {}` because WSelect's listbox is teleported to <body>, out of the wrapper
    const { wrapper } = mountPage({ stubs: {} })
    sockets[0].handshake()
    sockets[0].frame({ scope: 'jobs', message: 'a job ran' })
    sockets[0].frame({ scope: 'sql', message: 'a query ran' })
    await wrapper.vm.$nextTick()

    await wrapper.find('.w-select button, .w-select [role="combobox"]').trigger('click')
    const options = [...document.body.querySelectorAll('[role="option"]')].map((el) =>
      el.textContent.trim()
    )
    /*
      Populated from the frames seen so far, not from the whole 27-name vocabulary -- `terminal` is
      in there because the page's own connect/connected notes are real records under that scope,
      exactly as the server's own lifecycle lines for this socket are.
    */
    expect(options).toEqual(['jobs', 'sql', 'terminal'])

    wrapper.vm.state.scopes = ['sql']
    await wrapper.vm.$nextTick()

    expect(renderedMessages(wrapper)).toEqual(['a query ran'])
  })

  it('filters on free text across the message and the fields', async () => {
    const { wrapper } = mountPage()
    sockets[0].handshake()
    sockets[0].frame({ message: 'a job ran', fields: { job: 'purgeUploads' } })
    sockets[0].frame({ message: 'another job ran', fields: { job: 'rebuildTree' } })
    await wrapper.vm.$nextTick()

    const field = wrapper.find(`input[aria-label="${messages['admin.liveLog.filter']}"]`)
    await field.setValue('rebuildtree')

    expect(renderedMessages(wrapper)).toEqual(['another job ran'])
  })

  it('expands a stack on click and collapses it again', async () => {
    const { wrapper } = mountPage()
    sockets[0].handshake()
    sockets[0].frame({
      level: 'error',
      message: 'query failed',
      stack: 'Error: boom\n  at one\n  at two'
    })
    await wrapper.vm.$nextTick()

    const row = wrapper.findAll('.admin-live-log-row').at(-1)
    expect(row.find('.admin-live-log-stack').exists()).toBe(false)

    await row.trigger('click')
    expect(wrapper.find('.admin-live-log-stack').text()).toContain('at two')

    await wrapper.findAll('.admin-live-log-row').at(-1).trigger('click')
    expect(wrapper.find('.admin-live-log-stack').exists()).toBe(false)
  })

  it('buffers frames while paused and flushes them in order on resume', async () => {
    const { wrapper } = mountPage()
    sockets[0].handshake()
    await wrapper.vm.$nextTick()

    const pause = wrapper
      .findAll('button')
      .find((el) => el.text().includes(messages['admin.liveLog.pause']))
    await pause.trigger('click')

    sockets[0].frame({ message: 'first while paused' })
    sockets[0].frame({ message: 'second while paused' })
    await wrapper.vm.$nextTick()

    expect(renderedMessages(wrapper)).not.toContain('first while paused')
    expect(wrapper.find('.admin-live-log-paused').text()).toContain(
      messages['admin.liveLog.paused']
    )

    const resume = wrapper
      .findAll('button')
      .find((el) => el.text().includes(messages['admin.liveLog.resume']))
    await resume.trigger('click')

    const shown = renderedMessages(wrapper)
    expect(shown.slice(-2)).toEqual(['first while paused', 'second while paused'])
    expect(wrapper.find('.admin-live-log-paused').exists()).toBe(false)
  })

  it('shows the reason a 4403 refusal gives and offers a reconnect rather than retrying', async () => {
    const { wrapper } = mountPage()
    sockets[0].emit('close', { code: 4403, reason: 'You are not allowed to read the server logs' })
    await wrapper.vm.$nextTick()

    const last = renderedMessages(wrapper).at(-1)
    expect(last).toContain(messages['admin.liveLog.connectError'])
    expect(last).toContain('You are not allowed to read the server logs')
    // -> No second socket: the page does not reconnect on a refusal, and did not open one itself
    expect(sockets).toHaveLength(1)
    expect(
      wrapper.findAll('button').some((el) => el.text().includes(messages['admin.liveLog.connect']))
    ).toBe(true)
  })

  it('clears every retained row', async () => {
    const { wrapper } = mountPage()
    sockets[0].handshake()
    sockets[0].frame({ message: 'a job ran' })
    await wrapper.vm.$nextTick()
    expect(renderedMessages(wrapper).length).toBeGreaterThan(0)

    const clear = wrapper
      .findAll('button')
      .find((el) => el.text().includes(messages['admin.liveLog.clear']))
    await clear.trigger('click')

    expect(wrapper.vm.rows).toHaveLength(0)
    expect(wrapper.find('.admin-live-log-empty').text()).toBe(messages['admin.liveLog.none'])
  })

  it('closes the socket when the page unmounts', async () => {
    const { wrapper } = mountPage()
    sockets[0].handshake()
    wrapper.unmount()
    expect(sockets[0].closed).not.toBeNull()
  })

  describe('window arithmetic', () => {
    /*
      jsdom lays nothing out, so every height the page could measure is zero -- which is exactly why
      the window is computed from a declared row height rather than from the DOM. These assert that
      arithmetic directly; the rendered assertions above cover what it produces.
    */
    it('gives every collapsed row the same height and sums them into the scroll height', async () => {
      const { wrapper } = mountPage()
      sockets[0].handshake()
      for (let i = 0; i < 5; i += 1) {
        sockets[0].frame({ message: `line ${i}` })
      }
      await wrapper.vm.$nextTick()

      const count = wrapper.vm.visibleRows.length
      const unit = wrapper.vm.rowHeight(wrapper.vm.visibleRows[0])
      expect(wrapper.vm.totalHeight).toBe(count * unit)
      expect(wrapper.vm.offsets).toHaveLength(count + 1)
    })

    it('grows an expanded row by its stack line count, and the offsets after it with it', async () => {
      const { wrapper } = mountPage()
      sockets[0].handshake()
      sockets[0].frame({
        level: 'error',
        message: 'boom',
        stack: 'Error: boom\n  at one\n  at two'
      })
      sockets[0].frame({ message: 'after' })
      await wrapper.vm.$nextTick()

      const before = wrapper.vm.totalHeight
      const lastOffsetBefore = wrapper.vm.offsets.at(-1)

      await wrapper.findAll('.admin-live-log-row').at(-2).trigger('click')

      expect(wrapper.vm.totalHeight).toBeGreaterThan(before)
      expect(wrapper.vm.offsets.at(-1)).toBeGreaterThan(lastOffsetBefore)
      // -> Still one entry per row plus the closing bound; expansion changes heights, not the count
      expect(wrapper.vm.offsets).toHaveLength(wrapper.vm.visibleRows.length + 1)
    })

    it('renders a whole short list even though the viewport measures zero under jsdom', async () => {
      const { wrapper } = mountPage()
      sockets[0].handshake()
      for (let i = 0; i < 20; i += 1) {
        sockets[0].frame({ message: `line ${i}` })
      }
      await wrapper.vm.$nextTick()

      expect(wrapper.vm.windowRange.start).toBe(0)
      expect(wrapper.findAll('.admin-live-log-row')).toHaveLength(wrapper.vm.visibleRows.length)
    })
  })

  describe('retirement of the xterm terminal', () => {
    it('imports no xterm package', () => {
      expect(readFileSync(PAGE_PATH, 'utf-8')).not.toContain('@xterm/')
    })

    it('has every admin.liveLog string it renders in the locale catalogue', () => {
      const source = readFileSync(PAGE_PATH, 'utf-8')
      const used = [...source.matchAll(/admin\.liveLog\.[A-Za-z]+/g)].map((m) => m[0])
      expect(used.length).toBeGreaterThan(0)
      expect(used.filter((key) => !Object.hasOwn(localeCatalogue, key))).toEqual([])
    })

    it('leaves no admin.terminal.* key behind in the catalogue', () => {
      expect(
        Object.keys(localeCatalogue).filter((key) => key.startsWith('admin.terminal.'))
      ).toEqual([])
    })
  })
})
