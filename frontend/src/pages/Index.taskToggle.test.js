import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { queue } from '@/composables/notify'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

const STUBS = {
  PageHeader: true,
  PageActionsCol: true,
  PageToc: true,
  PageTags: true,
  SideDialog: true,
  PageRedirect: true,
  FooterNav: true,
  PageComments: true,
  PageCommentsEmbed: true
}

const SOURCE = '- [ ] first\n- [x] **second** item\n- [ ] third\n'

const RENDER =
  '<ul class="contains-task-list">' +
  '<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> first</li>' +
  '<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> <strong>second</strong> item</li>' +
  '<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> third</li>' +
  '</ul>'

const UPDATED_AT = '2026-09-21T10:00:00.000Z'
const TICKED_AT = '2026-09-21T10:05:00.000Z'

beforeEach(() => {
  window.matchMedia =
    window.matchMedia ??
    vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  Element.prototype.scrollIntoView = vi.fn()
  queue.splice(0)
})

let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
  vi.restoreAllMocks()
})

async function mountPage({ permissions }) {
  setActivePinia(createPinia())
  const router = await createTestRouter(['/:pathMatch(.*)*'], '/some-page')
  const i18n = createTestI18n({
    common: { page: { taskConflict: 'The page changed; the task was not updated.' } }
  })
  const wrapper = mount(Index, { global: { plugins: [router, i18n], stubs: STUBS } })
  activeWrapper = wrapper
  await flushPromises()

  const pageStore = usePageStore()
  useSiteStore().$patch({ id: 'site-1' })
  useUserStore().$patch({ pagePermissions: permissions })
  pageStore.$patch({
    id: 'page-1',
    notFound: false,
    isLocked: false,
    editor: 'markdown',
    render: RENDER,
    updatedAt: UPDATED_AT
  })
  await flushPromises()
  return { wrapper, pageStore }
}

function stubSource() {
  API_CLIENT.get.mockImplementation(() => ({
    json: () => Promise.resolve({ id: 'page-1', content: SOURCE })
  }))
}

describe('Index.vue: ticking a task from the reader view', () => {
  it('sends the ordinal and source text of the clicked box and adopts the reply', async () => {
    API_CLIENT.put.mockImplementation(() => ({
      json: () => Promise.resolve({ ok: true, updatedAt: TICKED_AT })
    }))
    const { wrapper, pageStore } = await mountPage({ permissions: ['write:pages'] })
    stubSource()

    const boxes = wrapper.findAll('input.task-list-item-checkbox')
    expect(boxes.map((b) => b.element.disabled)).toEqual([false, false, false])

    await boxes[1].setValue(false)
    await vi.waitFor(() => expect(API_CLIENT.put).toHaveBeenCalledTimes(1))
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-1/tasks/1', {
      json: { checked: false, text: '**second** item', expectedUpdatedAt: UPDATED_AT }
    })
    expect(pageStore.updatedAt).toBe(TICKED_AT)
    const after = wrapper.findAll('input.task-list-item-checkbox')
    expect(after.map((b) => b.element.checked)).toEqual([false, false, false])
    expect(after.map((b) => b.element.disabled)).toEqual([false, false, false])
    expect(queue).toHaveLength(0)
  })

  it('leaves a reader without write:pages with disabled boxes', async () => {
    const { wrapper } = await mountPage({ permissions: ['read:pages'] })

    const boxes = wrapper.findAll('input.task-list-item-checkbox')
    expect(boxes).toHaveLength(3)
    expect(boxes.every((b) => b.element.disabled)).toBe(true)
    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('reverts the box and toasts on a 409, without retrying', async () => {
    API_CLIENT.put.mockImplementation(() => ({
      json: () =>
        Promise.reject(
          Object.assign(new Error('Conflict'), {
            response: { status: 409 },
            data: { message: 'This page was changed since you loaded it.' }
          })
        )
    }))
    const { wrapper, pageStore } = await mountPage({ permissions: ['write:pages'] })
    stubSource()

    const box = wrapper.findAll('input.task-list-item-checkbox')[0]
    await box.setValue(true)
    await vi.waitFor(() => expect(queue).toHaveLength(1))

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('input.task-list-item-checkbox')[0].element.checked).toBe(false)
    expect(pageStore.updatedAt).toBe(UPDATED_AT)
    expect(queue.map((n) => n.message)).toEqual(['The page changed; the task was not updated.'])
  })
})
