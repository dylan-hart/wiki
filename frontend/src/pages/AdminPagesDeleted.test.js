import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AdminPagesDeleted from './AdminPagesDeleted.vue'
import { openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { buildTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * ky throws for both recover refusals, so the fixtures carry what tells them apart: a path conflict
 * is an HTTP 409 and nothing more, while an invalid locale is a 400 whose parsed body (`err.data`)
 * names the error. Each must reopen a picker rather than dead-end in an error toast.
 */

const row = {
  id: 'hist-1',
  action: 'deleted',
  path: 'old/path',
  locale: 'en',
  title: 'Old Page',
  changedFields: [],
  versionDate: '2024-01-01T00:00:00.000Z',
  author: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' }
}

function mockLoadEndpoints(rows = [row]) {
  stubApi(new Map([[/pages\/deleted/, { items: rows, nextCursor: null }]]), {
    fallback: { locales: { active: ['en', 'fr'] } }
  })
}

async function mountPage() {
  mockLoadEndpoints()

  const router = buildTestRouter(['/:pathMatch(.*)*'])

  const { wrapper } = mountWithApp(AdminPagesDeleted, {
    router,
    stores: {
      admin: {
        currentSiteId: 'site-1',
        locales: [
          { code: 'en', name: 'English', nativeName: 'English' },
          { code: 'fr', name: 'French', nativeName: 'French' }
        ]
      }
    }
  })
  await flushPromises()

  return { wrapper, router }
}

async function clickRecover(wrapper) {
  const recoverBtn = wrapper.findAll('button').find((b) => b.text() === 'history.recovery.recover')
  await recoverBtn.trigger('click')

  // -> Fire the confirmation's OK handler directly; the dialog itself is never rendered here
  const confirmDialog = openDialogs.at(-1)
  confirmDialog.handlers.ok[0](true)
  openDialogs.splice(openDialogs.indexOf(confirmDialog), 1)
  await flushPromises()
}

beforeEach(() => {
  openDialogs.splice(0, openDialogs.length)
  notifyQueue.splice(0, notifyQueue.length)
})

describe('AdminPagesDeleted: empty state (OpenProject #2061)', () => {
  it("renders the table's #no-data slot message when nothing has been deleted", async () => {
    mockLoadEndpoints([])

    const router = buildTestRouter(['/:pathMatch(.*)*'])
    const { wrapper } = mountWithApp(AdminPagesDeleted, {
      router,
      messages: { history: { recovery: { none: 'Nothing has been deleted yet.' } } },
      stores: { admin: { currentSiteId: 'site-1' } }
    })
    await flushPromises()

    expect(wrapper.vm.state.rows).toHaveLength(0)
    expect(wrapper.text()).toContain('Nothing has been deleted yet.')
  })
})

describe('AdminPagesDeleted: load()', () => {
  it('pages through the cursor until nextCursor is null, assembling the full list', async () => {
    const rowA = { ...row, id: 'hist-a', path: 'a' }
    const rowB = { ...row, id: 'hist-b', path: 'b' }
    const seenUrls = []

    globalThis.API_CLIENT.get.mockImplementation((url) => {
      seenUrls.push(String(url))
      if (String(url).includes('pages/deleted')) {
        if (!String(url).includes('cursor=')) {
          return { json: () => Promise.resolve({ items: [rowA], nextCursor: 'page-2' }) }
        }
        return { json: () => Promise.resolve({ items: [rowB], nextCursor: null }) }
      }
      return { json: () => Promise.resolve({ locales: { active: ['en'] } }) }
    })

    const router = buildTestRouter(['/:pathMatch(.*)*'])
    const { wrapper } = mountWithApp(AdminPagesDeleted, {
      router,
      stores: { admin: { currentSiteId: 'site-1' } }
    })
    await flushPromises()

    expect(wrapper.vm.state.rows.map((r) => r.id)).toEqual(['hist-a', 'hist-b'])
    expect(seenUrls.some((u) => u.includes('pages/deleted') && u.includes('cursor=page-2'))).toBe(
      true
    )
  })
})

describe('AdminPagesDeleted: recover()', () => {
  it('routes to the recovered page on success', async () => {
    const { wrapper, router } = await mountPage()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, page: { path: 'old/path' } })
    })

    await clickRecover(wrapper)

    expect(router.currentRoute.value.fullPath).toBe('/old/path')
  })

  it('on a 409 path conflict, opens the tree browser instead of just failing', async () => {
    const { wrapper } = await mountPage()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.reject(Object.assign(new Error('Conflict'), { response: { status: 409 } }))
    })

    await clickRecover(wrapper)

    const opened = openDialogs.at(-1)
    expect(opened).toBeDefined()
    expect(opened.props).toMatchObject({
      mode: 'duplicatePage',
      siteId: 'site-1',
      itemFileName: 'old/path'
    })
  })

  it('picking a new path in that browser retries recover with the override', async () => {
    const { wrapper, router } = await mountPage()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.reject(Object.assign(new Error('Conflict'), { response: { status: 409 } }))
    })
    await clickRecover(wrapper)

    const pathDialog = openDialogs.at(-1)
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, page: { path: 'old/path-2' } })
    })
    pathDialog.handlers.ok[0]({ path: 'old/path-2', title: 'Old Page' })
    await flushPromises()

    expect(globalThis.API_CLIENT.post).toHaveBeenLastCalledWith(
      'sites/site-1/pages/deleted/hist-1/recover',
      { json: { path: 'old/path-2' } }
    )
    expect(router.currentRoute.value.fullPath).toBe('/old/path-2')
  })

  it('on a 400 pageInvalidLocale refusal, offers the active locales instead of dead-ending', async () => {
    const { wrapper } = await mountPage()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.reject(
          Object.assign(new Error('Bad Request'), {
            response: { status: 400 },
            data: {
              ok: false,
              error: 'pageInvalidLocale',
              statusCode: 400,
              message: 'This site does not have the "en" locale enabled.'
            }
          })
        )
    })

    await clickRecover(wrapper)

    const opened = openDialogs.at(-1)
    expect(opened).toBeDefined()
    expect(opened.props.options.items.map((i) => i.value)).toEqual(['en', 'fr'])
  })

  it('picking a locale in that picker retries recover with the override', async () => {
    const { wrapper, router } = await mountPage()
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.reject(
          Object.assign(new Error('Bad Request'), {
            response: { status: 400 },
            data: { ok: false, error: 'pageInvalidLocale', statusCode: 400, message: 'x' }
          })
        )
    })
    await clickRecover(wrapper)

    const localeDialog = openDialogs.at(-1)
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, page: { path: 'old/path' } })
    })
    localeDialog.handlers.ok[0]('fr')
    await flushPromises()

    expect(globalThis.API_CLIENT.post).toHaveBeenLastCalledWith(
      'sites/site-1/pages/deleted/hist-1/recover',
      { json: { locale: 'fr' } }
    )
    expect(router.currentRoute.value.fullPath).toBe('/old/path')
  })
})
