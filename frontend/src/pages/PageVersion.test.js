import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import PageVersion from './PageVersion.vue'
import { mountWithApp } from '../../test/mount.js'
import { createTestRouter } from '../../test/router.js'

const { sanitize } = vi.hoisted(() => ({ sanitize: vi.fn((html) => html) }))

vi.mock('dompurify', () => ({ default: { sanitize } }))

const VERSION_ID = '33333333-3333-3333-3333-333333333333'

const MESSAGES = {
  history: {
    title: 'Page History',
    versionLink: {
      snapshot: 'Version from {date}',
      author: 'by {name}',
      viewCurrent: 'View the current page',
      notFound: 'Not found message',
      forbidden: 'Forbidden message',
      locked: 'Locked message',
      loadFailed: 'Load failed message'
    }
  }
}

function fixtureVersion(overrides = {}) {
  return {
    id: VERSION_ID,
    action: 'updated',
    versionDate: '2026-01-01T00:00:00.000Z',
    title: 'Old Title',
    content: '# Old heading\n\nSome *old* text.',
    contentType: 'markdown',
    author: { id: 'u1', name: 'Ada' },
    page: { id: 'p1', path: 'current/path', locale: 'en' },
    ...overrides
  }
}

function httpError(status, message) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
    data: { message }
  })
}

async function mountVersion(response) {
  const router = await createTestRouter(
    [{ path: '/_version/:id', component: PageVersion }, '/:pathMatch(.*)*'],
    `/_version/${VERSION_ID}`
  )
  API_CLIENT.get.mockImplementation(() => ({
    json: () => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response))
  }))
  const mounted = mountWithApp(PageVersion, {
    messages: MESSAGES,
    router,
    stores: { site: { id: 'site-1' } }
  })
  vi.spyOn(mounted.editorStore, 'ensureConfigs').mockResolvedValue()
  await flushPromises()
  return mounted
}

describe('PageVersion.vue (OpenProject #3692)', () => {
  it('fetches the version by id from the site-scoped endpoint', async () => {
    await mountVersion(fixtureVersion())

    expect(API_CLIENT.get).toHaveBeenCalledWith(`sites/site-1/versions/${VERSION_ID}`)
  })

  it('renders the version title and its markdown content read-only', async () => {
    const { wrapper } = await mountVersion(fixtureVersion())

    expect(wrapper.find('.page-version-title').text()).toBe('Old Title')
    expect(wrapper.find('.page-contents h1').text()).toBe('Old heading')
    expect(wrapper.find('.page-contents em').text()).toBe('old')
    expect(wrapper.find('textarea, input, [contenteditable]').exists()).toBe(false)
  })

  it('names the author and links to the page at its current path', async () => {
    const { wrapper } = await mountVersion(fixtureVersion())

    expect(wrapper.text()).toContain('by Ada')
    expect(wrapper.find('a').attributes('href')).toBe('/current/path')
  })

  it('draws only what DOMPurify returned for an html version, never the raw source', async () => {
    const raw = '<p onclick="alert(1)">Hello</p><script>alert(2)</script>'
    sanitize.mockReturnValueOnce('<p>Hello</p>')

    const { wrapper } = await mountVersion(fixtureVersion({ contentType: 'html', content: raw }))

    expect(sanitize).toHaveBeenCalledWith(raw)
    expect(wrapper.find('.page-contents').element.innerHTML).toBe('<p>Hello</p>')
  })

  it('sanitizes the markdown pipeline output too, since it may carry raw html', async () => {
    sanitize.mockReturnValueOnce('<h1>Clean</h1>')

    const { wrapper } = await mountVersion(fixtureVersion())

    expect(sanitize).toHaveBeenCalledWith(expect.stringContaining('<h1'))
    expect(wrapper.find('.page-contents h1').text()).toBe('Clean')
  })

  it('shows an unrenderable content type as plain source', async () => {
    const { wrapper } = await mountVersion(
      fixtureVersion({ contentType: 'redirect', content: '{"target":"/x"}' })
    )

    expect(wrapper.find('pre.page-version-source').text()).toBe('{"target":"/x"}')
  })

  it.each([
    [404, 'This version does not exist.', 'Not found message'],
    [403, "You are not allowed to read this page's history.", 'Forbidden message'],
    [403, 'This page is password protected.', 'Locked message'],
    [500, 'Boom', 'Load failed message']
  ])('answers a %i (%s) with its own message', async (status, message, expected) => {
    const { wrapper } = await mountVersion(httpError(status, message))

    expect(wrapper.find('[role="alert"]').text()).toBe(expected)
    expect(wrapper.find('.page-version-title').exists()).toBe(false)
  })
})

describe('the /_version/:id route', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '../router/routes.js'), 'utf8')

  it('is declared, under the main layout, ahead of the catch-all', () => {
    const versionAt = source.indexOf("path: '/_version/:id'")
    expect(versionAt).toBeGreaterThan(-1)
    expect(versionAt).toBeLessThan(source.indexOf("path: '/:catchAll(.*)*'"))
    expect(source.slice(versionAt, versionAt + 200)).toContain('MainLayout.vue')
    expect(source.slice(versionAt, versionAt + 300)).toContain('PageVersion.vue')
  })
})
