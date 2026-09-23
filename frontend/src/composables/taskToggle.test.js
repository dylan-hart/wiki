import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

import { log } from '@/helpers/log'
import { queue as notifyQueue } from '@/composables/notify'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useUserStore } from '@/stores/user'

import { renderWithTaskState, taskItemText, useTaskToggle } from './taskToggle'

import { createTestI18n } from '../../test/i18n.js'

describe('taskItemText', () => {
  const source = [
    '- [ ] one',
    '- [x] **two** item',
    '',
    '```',
    '- [ ] in a code block',
    '```',
    '',
    '1. [X] three',
    '- not a task',
    ''
  ].join('\n')

  it('counts task items in document order, code blocks excluded', async () => {
    expect(await taskItemText(source, 0)).toBe('one')
    expect(await taskItemText(source, 1)).toBe('**two** item')
    expect(await taskItemText(source, 2)).toBe('three')
  })

  it('answers null past the last item', async () => {
    expect(await taskItemText(source, 3)).toBeNull()
  })
})

describe('renderWithTaskState', () => {
  const render =
    '<ul><li><input class="task-list-item-checkbox" disabled="" type="checkbox"> a</li>' +
    '<li><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> b</li></ul>'

  it('ticks and unticks only the addressed box', () => {
    const ticked = renderWithTaskState(render, 0, true)
    expect(ticked).toContain(
      'class="task-list-item-checkbox" disabled="" type="checkbox" checked=""'
    )
    expect(ticked.match(/checked/g)).toHaveLength(2)

    const unticked = renderWithTaskState(render, 1, false)
    expect(unticked).not.toContain('checked')
  })

  it('answers null when the render has no such box', () => {
    expect(renderWithTaskState(render, 2, true)).toBeNull()
  })
})

describe('useTaskToggle', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    notifyQueue.splice(0)
    vi.restoreAllMocks()
  })

  function mountToggle({ content }) {
    const container = ref(null)
    let api = null
    const wrapper = mount(
      {
        setup() {
          const pageStore = usePageStore()
          pageStore.$patch({
            id: 'page-1',
            editor: 'markdown',
            isLocked: false,
            notFound: false,
            content,
            contentLoaded: true
          })
          useEditorStore().isActive = false
          useUserStore().pagePermissions = ['write:pages']
          api = useTaskToggle(container)
          return { container }
        },
        template:
          '<div ref="container"><input class="task-list-item-checkbox" type="checkbox"></div>'
      },
      {
        global: {
          plugins: [createTestI18n({ common: { page: { taskConflict: 'Task conflict' } } })]
        }
      }
    )
    return { api, wrapper }
  }

  it('reverts the box and shows the conflict toast when the task is gone from the source', async () => {
    const warn = vi.spyOn(log, 'warn')
    const { api, wrapper } = mountToggle({ content: 'no tasks here\n' })
    const box = wrapper.find('input').element
    box.checked = true

    api.onContentChange({ target: box })

    await vi.waitFor(() => expect(notifyQueue).toHaveLength(1))
    expect(notifyQueue[0]).toMatchObject({ type: 'negative', message: 'Task conflict' })
    expect(box.checked).toBe(false)
    expect(API_CLIENT.put).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})
