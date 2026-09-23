import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises } from '@vue/test-utils'

import { QUICK_NOTE_ROUTE, isQuickNoteChord, useQuickNote, useQuickNoteShortcut } from './quickNote'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

function chord(overrides = {}) {
  return {
    code: 'KeyN',
    key: 'n',
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('isQuickNoteChord', () => {
  it('matches Cmd+Option+N even though Option+N is a dead key on macOS', () => {
    expect(isQuickNoteChord(chord({ metaKey: true, key: 'Dead' }))).toBe(true)
    expect(isQuickNoteChord(chord({ metaKey: true, key: '˜' }))).toBe(true)
  })

  it('matches Ctrl+Alt+N', () => {
    expect(isQuickNoteChord(chord({ ctrlKey: true }))).toBe(true)
    expect(isQuickNoteChord(chord({ ctrlKey: true, key: 'N' }))).toBe(true)
  })

  it('ignores Ctrl+Alt+N that typed another character, as AltGr+N does on a Polish layout', () => {
    expect(isQuickNoteChord(chord({ ctrlKey: true, key: 'ń' }))).toBe(false)
    expect(isQuickNoteChord(chord({ ctrlKey: true, key: 'Dead' }))).toBe(false)
  })

  it('follows the typed letter for Ctrl+Alt, so a non-QWERTY layout gets its own N key', () => {
    expect(isQuickNoteChord(chord({ ctrlKey: true, code: 'KeyL', key: 'n' }))).toBe(true)
    expect(isQuickNoteChord(chord({ ctrlKey: true, code: 'KeyN', key: 'b' }))).toBe(false)
  })

  it('rejects other modifier combinations and keys', () => {
    expect(isQuickNoteChord(chord())).toBe(false)
    expect(isQuickNoteChord(chord({ altKey: false, ctrlKey: true }))).toBe(false)
    expect(isQuickNoteChord(chord({ altKey: false, metaKey: true }))).toBe(false)
    expect(isQuickNoteChord(chord({ ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isQuickNoteChord(chord({ ctrlKey: true, metaKey: true }))).toBe(false)
    expect(isQuickNoteChord(chord({ ctrlKey: true, code: 'KeyM', key: 'm' }))).toBe(false)
    expect(isQuickNoteChord(chord({ metaKey: true, code: 'KeyM', key: 'n' }))).toBe(false)
    expect(isQuickNoteChord(null)).toBe(false)
  })
})

let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
})

async function mountHarness({ authenticated = true, notes, overlay = null } = {}) {
  const router = await createTestRouter(['/', '/_notes', '/_admin'], '/')
  let api = null
  const Harness = defineComponent({
    setup() {
      useQuickNoteShortcut()
      api = useQuickNote()
      return () => h('div')
    }
  })
  const { wrapper, siteStore, userStore } = mountWithApp(Harness, {
    router,
    stores: {
      user: (store) => store.$patch({ authenticated }),
      site: (store) => {
        if (notes !== undefined) {
          store.features.notes = notes
        }
        store.overlay = overlay
      }
    }
  })
  activeWrapper = wrapper
  await flushPromises()
  return { wrapper, router, siteStore, userStore, api }
}

function pressQuickNote(overrides = {}) {
  const ev = new KeyboardEvent('keydown', {
    code: 'KeyN',
    key: 'n',
    ctrlKey: true,
    altKey: true,
    cancelable: true,
    ...overrides
  })
  window.dispatchEvent(ev)
  return ev
}

describe('useQuickNote', () => {
  it('targets /_notes?new=1', () => {
    expect(QUICK_NOTE_ROUTE).toEqual({ path: '/_notes', query: { new: '1' } })
  })

  it('is available to a signed-in user on a site without the notes flag', async () => {
    const { api } = await mountHarness()
    expect(api.available.value).toBe(true)
  })

  it('is unavailable to a guest', async () => {
    const { api, router } = await mountHarness({ authenticated: false })
    expect(api.available.value).toBe(false)
    expect(api.open()).toBe(false)
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('is unavailable when the site turns notes off', async () => {
    const { api } = await mountHarness({ notes: false })
    expect(api.available.value).toBe(false)
  })

  it('navigates to the new-note route when opened', async () => {
    const { api, router } = await mountHarness({ notes: true })
    expect(api.open()).toBe(true)
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/_notes')
    expect(router.currentRoute.value.query).toEqual({ new: '1' })
  })
})

describe('useQuickNoteShortcut', () => {
  it('opens a new note on Ctrl+Alt+N', async () => {
    const { router } = await mountHarness()
    const ev = pressQuickNote()
    await flushPromises()
    expect(ev.defaultPrevented).toBe(true)
    expect(router.currentRoute.value.fullPath).toBe('/_notes?new=1')
  })

  it('opens a new note on Cmd+Option+N', async () => {
    const { router } = await mountHarness()
    pressQuickNote({ ctrlKey: false, metaKey: true, key: 'Dead' })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/_notes?new=1')
  })

  it('does nothing for a guest', async () => {
    const { router } = await mountHarness({ authenticated: false })
    const ev = pressQuickNote()
    await flushPromises()
    expect(ev.defaultPrevented).toBe(false)
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('does nothing when the site turns notes off', async () => {
    const { router } = await mountHarness({ notes: false })
    const ev = pressQuickNote()
    await flushPromises()
    expect(ev.defaultPrevented).toBe(false)
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('does nothing while an overlay is open', async () => {
    const { router } = await mountHarness({ overlay: 'Inbox' })
    pressQuickNote()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('ignores key repeat', async () => {
    const { router } = await mountHarness()
    pressQuickNote({ repeat: true })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('stops listening once unmounted', async () => {
    const { wrapper, router } = await mountHarness()
    wrapper.unmount()
    activeWrapper = null
    pressQuickNote()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
  })
})
