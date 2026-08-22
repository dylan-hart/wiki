import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import './component.js'

const SITE_ID = 'site-1'
const PAGE_ID = 'page-1'

/**
 * Appends a `<block-checklist>` carrying `items` as its light-DOM content, one `<li>` per item — the
 * shape MDC leaves behind for a plain markdown bullet list nested inside `::block-checklist` (see the
 * component's own header comment). Waits for the load this block always kicks off on connect.
 */
async function mountChecklist({
  runKey = 'shift-open',
  heading = '',
  items = ['First', 'Second']
} = {}) {
  const el = document.createElement('block-checklist')
  el.runKey = runKey
  el.heading = heading
  el.innerHTML =
    items.length > 0 ? `<ul>${items.map((label) => `<li>${label}</li>`).join('')}</ul>` : ''
  document.body.appendChild(el)
  await el.updateComplete
  // -> `_load()`'s API_CLIENT.get is awaited but not blocking connectedCallback itself; one more
  //    microtask turn plus a second updateComplete is enough for the mocked promise to resolve and
  //    the state it sets to reach a render.
  await new Promise((resolve) => queueMicrotask(resolve))
  await el.updateComplete
  return el
}

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

describe('block-checklist', () => {
  beforeEach(() => {
    globalThis.WIKI_STATE = {
      site: { id: SITE_ID },
      page: { id: PAGE_ID },
      user: { can: vi.fn(() => true) }
    }
    globalThis.API_CLIENT = {
      get: vi.fn(() => ({ json: () => Promise.resolve(null) })),
      post: vi.fn(() => ({ json: () => Promise.resolve(stubExecution()) }))
    }
  })

  afterEach(() => {
    document.body.replaceChildren()
    document.body.className = ''
    delete globalThis.WIKI_STATE
    delete globalThis.API_CLIENT
  })

  it('reads the body into items and shows a not-started summary when nothing has run yet', async () => {
    const el = await mountChecklist({ items: ['Check exits', 'Test alarm'] })

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith(
      `sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/executions/latest`
    )
    const labels = [...el.shadowRoot.querySelectorAll('.label')].map((n) => n.textContent.trim())
    expect(labels).toEqual(['Check exits', 'Test alarm'])
    expect(el.shadowRoot.querySelector('.summary').textContent).toContain('Not started yet')
  })

  it('shows an error when the checklist has no Run Key', async () => {
    const el = await mountChecklist({ runKey: '' })

    expect(el.shadowRoot.querySelector('.error').textContent).toContain('Run Key')
    expect(globalThis.API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('shows an error when the checklist has no items', async () => {
    const el = await mountChecklist({ items: [] })

    expect(el.shadowRoot.querySelector('.error').textContent).toContain('no items')
    expect(globalThis.API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('renders an active execution: checked items show who and when, unchecked ones stay open', async () => {
    globalThis.API_CLIENT.get = vi.fn(() => ({
      json: () =>
        Promise.resolve(
          stubExecution({
            checkedCount: 1,
            items: [
              { itemKey: 'item-0', checkedByName: 'Alice', checkedAt: '2026-01-01T08:00:00.000Z' }
            ]
          })
        )
    }))

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
    globalThis.API_CLIENT.get = vi.fn(() => ({
      json: () =>
        Promise.resolve(
          stubExecution({
            checkedCount: 2,
            completedAt: '2026-01-01T09:00:00.000Z',
            completedBy: 'user-2',
            completedByName: 'Bob',
            items: [
              { itemKey: 'item-0', checkedByName: 'Alice', checkedAt: '2026-01-01T08:00:00.000Z' },
              { itemKey: 'item-1', checkedByName: 'Bob', checkedAt: '2026-01-01T09:00:00.000Z' }
            ]
          })
        )
    }))

    const el = await mountChecklist()

    const summary = el.shadowRoot.querySelector('.summary')
    expect(summary.textContent).toContain('Completed by Bob')
    expect(summary.classList.contains('completed')).toBe(true)
  })

  it('checking an unchecked item posts the check and re-renders from the response', async () => {
    globalThis.API_CLIENT.post = vi.fn(() => ({
      json: () =>
        Promise.resolve(
          stubExecution({
            checkedCount: 1,
            startedByName: 'Alice',
            items: [
              { itemKey: 'item-0', checkedByName: 'Alice', checkedAt: '2026-01-01T08:00:00.000Z' }
            ]
          })
        )
    }))

    const el = await mountChecklist()
    const [firstBox] = el.shadowRoot.querySelectorAll('input[type="checkbox"]')
    firstBox.checked = true
    firstBox.dispatchEvent(new Event('change'))
    await el.updateComplete
    await new Promise((resolve) => queueMicrotask(resolve))
    await el.updateComplete

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/items`,
      { json: { itemKey: 'item-0', itemCount: 2 } }
    )
    expect(el.shadowRoot.querySelector('.summary').textContent).toContain('1 of 2 checked')
  })

  it('never posts when the reader has no write:pages, matching the disabled checkbox', async () => {
    globalThis.WIKI_STATE.user.can = vi.fn(() => false)

    const el = await mountChecklist()
    const [firstBox] = el.shadowRoot.querySelectorAll('input[type="checkbox"]')
    expect(firstBox.disabled).toBe(true)

    firstBox.dispatchEvent(new Event('change'))
    await el.updateComplete

    expect(globalThis.API_CLIENT.post).not.toHaveBeenCalled()
  })

  describe('dark mode', () => {
    beforeEach(() => {
      document.body.classList.remove('body--dark')
    })

    it('follows body--dark on mount and on later toggles, via the shared DarkMode controller', async () => {
      document.body.classList.add('body--dark')
      const el = await mountChecklist()

      expect(el.hasAttribute('dark')).toBe(true)

      document.body.classList.remove('body--dark')
      await new Promise((resolve) => queueMicrotask(resolve))
      await el.updateComplete

      expect(el.hasAttribute('dark')).toBe(false)
    })
  })
})
