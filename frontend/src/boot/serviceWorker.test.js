import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { log } from '../helpers/log'
import { initializeServiceWorker } from './serviceWorker.js'

vi.mock('../helpers/log', () => ({ log: { warn: vi.fn() } }))

let registerMock

function stubReadyState(value) {
  vi.spyOn(document, 'readyState', 'get').mockReturnValue(value)
}

beforeEach(() => {
  registerMock = vi.fn().mockResolvedValue({})
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register: registerMock },
    configurable: true
  })
})

afterEach(() => {
  delete navigator.serviceWorker
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  log.warn.mockClear()
})

describe('initializeServiceWorker', () => {
  it('registers /sw.js with no scope override once the document has loaded', () => {
    vi.stubEnv('DEV', false)
    stubReadyState('complete')

    initializeServiceWorker()

    expect(registerMock).toHaveBeenCalledTimes(1)
    expect(registerMock).toHaveBeenCalledWith('/sw.js')
  })

  it('defers registration to the window load event while the document is still loading', () => {
    vi.stubEnv('DEV', false)
    stubReadyState('loading')

    initializeServiceWorker()
    expect(registerMock).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('load'))
    expect(registerMock).toHaveBeenCalledWith('/sw.js')
  })

  it('does nothing under the dev server', () => {
    vi.stubEnv('DEV', true)
    stubReadyState('complete')

    initializeServiceWorker()

    expect(registerMock).not.toHaveBeenCalled()
  })

  it('does nothing when the browser has no service worker support', () => {
    vi.stubEnv('DEV', false)
    stubReadyState('complete')
    delete navigator.serviceWorker

    expect(() => initializeServiceWorker()).not.toThrow()
    expect(registerMock).not.toHaveBeenCalled()
  })

  it('logs a registration failure instead of rejecting', async () => {
    vi.stubEnv('DEV', false)
    stubReadyState('complete')
    const failure = new Error('bad worker')
    registerMock.mockRejectedValue(failure)

    expect(() => initializeServiceWorker()).not.toThrow()

    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith('app', 'could not register the service worker', failure)
    )
  })
})
