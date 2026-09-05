import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useFlagsStore } from './flags.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('flags store: load()', () => {
  it('fetches system flags and applies them, setting loaded true', async () => {
    const store = useFlagsStore()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ experimental: true, authDebug: false, sqlLog: true })
    })

    await store.load()

    expect(API_CLIENT.get).toHaveBeenCalledWith('system/flags')
    expect(store.loaded).toBe(true)
    expect(store.experimental).toBe(true)
    expect(store.authDebug).toBe(false)
    expect(store.sqlLog).toBe(true)
  })

  it('throws and leaves loaded false when the response is empty', async () => {
    const store = useFlagsStore()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(null) })

    // -> The KEY, not the English behind it: `boot/i18n.js` boots with no messages loaded, so a
    //    store translating outside the app resolves to the key -- which is what a reader would see
    //    on any screen drawn before the locale has landed, and is what this path must not crash on.
    await expect(store.load()).rejects.toThrow('admin.flags.loadFailed')
    expect(store.loaded).toBe(false)
  })

  it('rethrows when the request itself fails, leaving loaded false', async () => {
    const store = useFlagsStore()
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network down')
    })

    await expect(store.load()).rejects.toThrow('network down')
    expect(store.loaded).toBe(false)
  })
})

describe('flags store: apply()', () => {
  it('patches in the given flags alongside loaded: true', () => {
    const store = useFlagsStore()

    store.apply({ experimental: true })

    expect(store.loaded).toBe(true)
    expect(store.experimental).toBe(true)
    // -> Flags not present in the payload keep their prior (default) value
    expect(store.authDebug).toBe(false)
  })
})
