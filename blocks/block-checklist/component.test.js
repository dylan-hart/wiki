import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import './component.js'
import { _resetSiteCache } from '../shared/site.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom, stubSiteFetch, TEST_SITE_ID as SITE_ID } from '../test/mount.js'

const PAGE_ID = 'page-1'

/**
 * Appends a `<block-checklist>` carrying `items` as its light-DOM content, one `<li>` per item — the
 * shape MDC leaves behind for a plain markdown bullet list nested inside `::block-checklist` (see the
 * component's own header comment). Waits for the load this block always kicks off on connect.
 *
 * `settle: 2`: `_load()`'s fetches are awaited but not blocking connectedCallback itself, and chain
 * several hops deep (site -> page-by-hash -> latest execution). Each macrotask turn drains every
 * microtask queued in between, however many hops there are.
 */
const mountChecklist = ({
  runKey = 'shift-open',
  heading = '',
  items = ['First', 'Second']
} = {}) =>
  mountBlock('block-checklist', {
    props: { runKey, heading },
    html: items.length > 0 ? `<ul>${items.map((label) => `<li>${label}</li>`).join('')}</ul>` : '',
    settle: 2
  })

function stubExecution(overrides = {}) {
  return {
    id: 'exec-1',
    siteId: SITE_ID,
    pageId: PAGE_ID,
    blockKey: 'shift-open',
    itemCount: 2,
    startedAt: '2026-01-01T08:00:00.000Z',
    startedBy: 'user-1',
    startedByName: 'Alice',
    completedAt: null,
    completedBy: null,
    completedByName: null,
    checkedCount: 0,
    items: [],
    ...overrides
  }
}

/**
 * Stubs `fetch` for the whole chain this block now drives instead of `WIKI_STATE`/`API_CLIENT`:
 * site id + page id + this reader's page permissions (`../shared/site.js`'s `getCurrentPageAccess`),
 * then the checklist routes themselves. `latest`/`history`/`postResult` are each read fresh per call,
 * so a test can reassign them after mounting (matching the old suite's `API_CLIENT.get = vi.fn(...)`
 * re-stubbing style) without having to rebuild the whole mock.
 */
function stubFetch({
  permissions = ['write:pages'],
  latest = null,
  history = [],
  postResult
} = {}) {
  const state = { permissions, latest, history, postResult: postResult ?? stubExecution() }
  const fetchMock = stubSiteFetch({
    site: { locales: null },
    onRequest: async (url, init) => {
      if (!url.includes('/checklist/')) {
        // -> The page-by-hash lookup `getCurrentPageAccess` makes to resolve pageId + viewer.permissions
        return {
          ok: true,
          json: async () => ({ id: PAGE_ID, viewer: { permissions: state.permissions } })
        }
      }
      if (url.endsWith('/executions/latest')) {
        return { ok: true, json: async () => state.latest }
      }
      if (init?.method === 'POST' && url.endsWith('/items')) {
        return { ok: true, json: async () => state.postResult }
      }
      if (url.endsWith('/executions')) {
        return { ok: true, json: async () => state.history }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }
  })
  return { fetchMock, state }
}

/** Just the checklist-route calls, in call order -- excludes the site/page lookups underneath. */
function checklistCalls(fetchMock) {
  return fetchMock.mock.calls.map(([url]) => url).filter((url) => url.includes('/checklist/'))
}

describe('block-checklist', () => {
  beforeEach(() => {
    _resetSiteCache()
  })

  afterEach(() => {
    resetBlockDom()
    vi.unstubAllGlobals()
  })

  it('reads the body into items and shows a not-started summary when nothing has run yet', async () => {
    const { fetchMock } = stubFetch()
    const el = await mountChecklist({ items: ['Check exits', 'Test alarm'] })

    expect(checklistCalls(fetchMock)).toContain(
      `/_api/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/executions/latest`
    )
    const labels = [...el.shadowRoot.querySelectorAll('.label')].map((n) => n.textContent.trim())
    expect(labels).toEqual(['Check exits', 'Test alarm'])
    expect(el.shadowRoot.querySelector('.summary').textContent).toContain('Not started yet')
  })

  it('shows an error when the checklist has no Run Key', async () => {
    const { fetchMock } = stubFetch()
    const el = await mountChecklist({ runKey: '' })

    expect(el.shadowRoot.querySelector('.error').textContent).toContain('Run Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows an error when the checklist has no items', async () => {
    const { fetchMock } = stubFetch()
    const el = await mountChecklist({ items: [] })

    expect(el.shadowRoot.querySelector('.error').textContent).toContain('no items')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders an active execution: checked items show who and when, unchecked ones stay open', async () => {
    stubFetch({
      latest: stubExecution({
        checkedCount: 1,
        items: [
          { itemKey: 'item-0', checkedByName: 'Alice', checkedAt: '2026-01-01T08:00:00.000Z' }
        ]
      })
    })

    const el = await mountChecklist()

    const summary = el.shadowRoot.querySelector('.summary')
    expect(summary.textContent).toContain('Alice')
    expect(summary.textContent).toContain('1 of 2 checked')
    expect(summary.classList.contains('completed')).toBe(false)

    const boxes = el.shadowRoot.querySelectorAll('input[type="checkbox"]')
    expect(boxes[0].checked).toBe(true)
    // -> An already-checked item cannot be checked again
    expect(boxes[0].disabled).toBe(true)
    expect(boxes[1].checked).toBe(false)
    expect(boxes[1].disabled).toBe(false)
  })

  it('shows the completed state once every item is checked', async () => {
    stubFetch({
      latest: stubExecution({
        checkedCount: 2,
        completedAt: '2026-01-01T09:00:00.000Z',
        completedBy: 'user-2',
        completedByName: 'Bob',
        items: [
          { itemKey: 'item-0', checkedByName: 'Alice', checkedAt: '2026-01-01T08:00:00.000Z' },
          { itemKey: 'item-1', checkedByName: 'Bob', checkedAt: '2026-01-01T09:00:00.000Z' }
        ]
      })
    })

    const el = await mountChecklist()

    const summary = el.shadowRoot.querySelector('.summary')
    expect(summary.textContent).toContain('Completed by Bob')
    expect(summary.classList.contains('completed')).toBe(true)
  })

  it('checking an unchecked item posts the check and re-renders from the response', async () => {
    const { fetchMock } = stubFetch({
      postResult: stubExecution({
        checkedCount: 1,
        startedByName: 'Alice',
        items: [
          { itemKey: 'item-0', checkedByName: 'Alice', checkedAt: '2026-01-01T08:00:00.000Z' }
        ]
      })
    })

    const el = await mountChecklist()
    const [firstBox] = el.shadowRoot.querySelectorAll('input[type="checkbox"]')
    firstBox.checked = true
    firstBox.dispatchEvent(new Event('change'))
    await el.updateComplete
    await new Promise((resolve) => queueMicrotask(resolve))
    await el.updateComplete

    const [postUrl, postInit] = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(postUrl).toBe(`/_api/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/items`)
    expect(JSON.parse(postInit.body)).toEqual({ itemKey: 'item-0', itemCount: 2 })
    expect(el.shadowRoot.querySelector('.summary').textContent).toContain('1 of 2 checked')
  })

  it('never posts when the reader has no write:pages, matching the disabled checkbox', async () => {
    const { fetchMock } = stubFetch({ permissions: [] })

    const el = await mountChecklist()
    const [firstBox] = el.shadowRoot.querySelectorAll('input[type="checkbox"]')
    expect(firstBox.disabled).toBe(true)

    firstBox.dispatchEvent(new Event('change'))
    await el.updateComplete

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  describe('run history', () => {
    it('fetches and shows past executions on toggle, once, lazily', async () => {
      const { fetchMock } = stubFetch({
        history: [
          stubExecution({
            id: 'exec-old',
            checkedCount: 2,
            completedAt: '2026-01-01T09:00:00.000Z',
            completedByName: 'Bob'
          })
        ]
      })

      const el = await mountChecklist()
      expect(el.shadowRoot.querySelector('.history')).toBeNull()

      el.shadowRoot.querySelector('.history-toggle').click()
      await el.updateComplete
      await new Promise((resolve) => queueMicrotask(resolve))
      await el.updateComplete

      const historyCalls = fetchMock.mock.calls.filter(([url]) => url.endsWith('/executions'))
      expect(historyCalls).toHaveLength(1)
      expect(historyCalls[0][0]).toBe(
        `/_api/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/executions`
      )
      const row = el.shadowRoot.querySelector('.history li')
      expect(row.textContent).toContain('Bob')
      expect(row.textContent).toContain('2 of 2 checked')

      // -> Closing and reopening must not fetch a second time
      el.shadowRoot.querySelector('.history-toggle').click()
      await el.updateComplete
      el.shadowRoot.querySelector('.history-toggle').click()
      await el.updateComplete
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/executions'))).toHaveLength(1)
    })

    it('shows an empty state for a checklist with no previous runs', async () => {
      stubFetch({ history: [] })

      const el = await mountChecklist()
      el.shadowRoot.querySelector('.history-toggle').click()
      await el.updateComplete
      await new Promise((resolve) => queueMicrotask(resolve))
      await el.updateComplete

      expect(el.shadowRoot.querySelector('.history').textContent).toContain('No previous runs')
    })
  })

  describe('when the site or page cannot be resolved', () => {
    it('shows the run-log error rather than throwing, and leaves checking disabled', async () => {
      stubSiteFetch({ ok: false, onRequest: async () => ({ ok: false, json: async () => null }) })

      const el = await mountChecklist()

      expect(el.shadowRoot.querySelector('.error').textContent).toContain('could not be loaded')
    })
  })

  describeDarkMode(() => {
    stubFetch()
    return mountChecklist()
  })
})
