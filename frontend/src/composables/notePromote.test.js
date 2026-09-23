import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import { dialog } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { promoteDefaultTitle, useNotePromote } from './notePromote.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

vi.mock('@/composables/dialog', () => ({ dialog: vi.fn() }))
vi.mock('@/composables/notify', () => ({ notify: vi.fn() }))

const NOTE_URL = '/_api/sites/site-1/notes/note-1/images/img-1'

function answerDialog(result) {
  dialog.mockImplementation(() => {
    const chain = {
      onOk(cb) {
        if (result) {
          cb(result)
        }
        return chain
      },
      onCancel(cb) {
        if (!result) {
          cb()
        }
        return chain
      }
    }
    return chain
  })
}

function mountPromote(router) {
  const Host = defineComponent({
    setup() {
      return useNotePromote()
    },
    render: () => null
  })
  const mounted = mountWithApp(Host, {
    router,
    stores: {
      site: { id: 'site-1' },
      editor: { configIsLoaded: true }
    }
  })
  vi.spyOn(mounted.editorStore, 'ensureConfigs').mockResolvedValue()
  return mounted
}

describe('promoteDefaultTitle', () => {
  it("prefers the note's own title, then its first line", () => {
    expect(promoteDefaultTitle({ title: ' Plan ', excerpt: 'first line' })).toBe('Plan')
    expect(promoteDefaultTitle({ title: null, excerpt: 'first line' })).toBe('first line')
    expect(promoteDefaultTitle({ title: '  ', excerpt: '' })).toBe('')
    expect(promoteDefaultTitle(undefined)).toBe('')
  })
})

describe('useNotePromote().promote', () => {
  let router

  beforeEach(async () => {
    router = await createTestRouter(['/', '/:path(.*)*'], '/')
    API_CLIENT.post.mockImplementation(() => ({
      json: () => Promise.resolve({ ok: true, pageId: 'p1', path: 'docs/idea', locale: 'en' })
    }))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('opens the page save picker prefilled from the note', async () => {
    answerDialog(null)
    const { wrapper } = mountPromote(router)

    await wrapper.vm.promote({ id: 'note-1', title: null, excerpt: 'A rough idea' })

    expect(dialog).toHaveBeenCalledTimes(1)
    expect(dialog.mock.calls[0][0].componentProps).toEqual({
      mode: 'savePage',
      itemTitle: 'A rough idea'
    })
    expect(API_CLIENT.post).not.toHaveBeenCalled()
  })

  it('posts the chosen path and title with a render of the note, then opens the new page', async () => {
    answerDialog({ path: 'docs/idea', title: 'Idea' })
    const { wrapper } = mountPromote(router)
    const push = vi.spyOn(router, 'push')

    const result = await wrapper.vm.promote({
      id: 'note-1',
      title: 'Idea',
      content: `# Idea\n\n![sketch](${NOTE_URL})\n`,
      updatedAt: '2026-09-23T10:00:00.000Z'
    })

    expect(result).toMatchObject({ pageId: 'p1', path: 'docs/idea' })
    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)
    const [url, options] = API_CLIENT.post.mock.calls[0]
    expect(url).toBe('sites/site-1/notes/note-1/promote')
    expect(options.json).toMatchObject({
      path: 'docs/idea',
      title: 'Idea',
      noteUpdatedAt: '2026-09-23T10:00:00.000Z'
    })
    expect(options.json.render).toContain(`src="${NOTE_URL}"`)
    expect(options.json.render).toContain('Idea</h1>')
    expect(push).toHaveBeenCalledWith('/docs/idea')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'positive' }))
  })

  it('reads the note from the API when the caller has only its list entry', async () => {
    answerDialog({ path: 'docs/idea', title: 'Idea' })
    API_CLIENT.get.mockImplementation(() => ({
      json: () =>
        Promise.resolve({ id: 'note-1', content: 'Body', updatedAt: '2026-09-23T11:00:00.000Z' })
    }))
    const { wrapper } = mountPromote(router)

    await wrapper.vm.promote({ id: 'note-1', title: 'Idea', excerpt: 'Body' })

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/notes/note-1')
    expect(API_CLIENT.post.mock.calls[0][1].json.noteUpdatedAt).toBe('2026-09-23T11:00:00.000Z')
  })

  it('reports a refusal and stays put', async () => {
    answerDialog({ path: 'docs/taken', title: 'Idea' })
    API_CLIENT.post.mockImplementation(() => ({
      json: () => Promise.reject(new Error('conflict'))
    }))
    const { wrapper } = mountPromote(router)
    const push = vi.spyOn(router, 'push')

    const result = await wrapper.vm.promote({
      id: 'note-1',
      title: 'Idea',
      content: 'Body',
      updatedAt: '2026-09-23T10:00:00.000Z'
    })

    expect(result).toBeNull()
    expect(push).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'negative', message: 'notes.promote.failed' })
    )
  })
})
