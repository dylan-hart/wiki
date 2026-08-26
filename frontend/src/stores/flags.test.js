import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useFlagsStore } from './flags.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('flags store: load()', () => {
  it('fetches system/flags and applies the response, leaving experimental and loaded true', async () => {
    const store = useFlagsStore()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ experimental: true }) })

    await store.load()

    expect(API_CLIENT.get).toHaveBeenCalledWith('system/flags')
    expect(store.experimental).toBe(true)
    expect(store.loaded).toBe(true)
  })

  it('rejects with a fixed message and leaves loaded false when the response is empty', async () => {
    const store = useFlagsStore()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(null) })

    await expect(store.load()).rejects.toThrow('Could not fetch system flags.')

    expect(store.loaded).toBe(false)
  })

  it('rethrows and leaves loaded false when the request itself fails', async () => {
    const store = useFlagsStore()
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network down')
    })

    await expect(store.load()).rejects.toThrow('network down')

    expect(store.loaded).toBe(false)
  })
})

describe('flags store: apply()', () => {
  it('sets loaded true alongside arbitrary server keys, without disturbing the other defaults', () => {
    const store = useFlagsStore()

    store.apply({ experimental: true })

    expect(store.loaded).toBe(true)
    expect(store.experimental).toBe(true)
    expect(store.authDebug).toBe(false)
    expect(store.sqlLog).toBe(false)
  })
})
