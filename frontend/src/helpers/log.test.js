import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia, getActivePinia } from 'pinia'

import { useFlagsStore } from '@/stores/flags'

import { log, LOG_SCOPES } from './log.js'

/*
  This suite is the one place in `frontend/src` that reads the console rather than writing to it: the
  helper's whole contract IS what reaches `console.warn`/`.error`/`.debug` and when, so a spy on each
  is the subject, not a workaround.
*/
let warnSpy
let errorSpy
let debugSpy

beforeEach(() => {
  setActivePinia(createPinia())
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('log: prefix format', () => {
  it('prefixes the message with the scope, and passes the error through as a second argument', () => {
    const err = new Error('network')

    log.error('api', 'could not reach the server', err)

    expect(errorSpy).toHaveBeenCalledWith('[cardinal:api] could not reach the server', err)
  })

  it('does not stringify the error, so the browser can expand its own stack', () => {
    const err = new Error('boom')

    log.warn('page', 'could not load the page', err)

    // -> The object itself, not `err.message` and not `String(err)` -- an interpolated message is a
    //    flat line with no stack behind it
    expect(warnSpy.mock.calls[0][1]).toBe(err)
  })

  it('omits the error argument entirely when the caller had nothing to pass', () => {
    log.warn('site', 'no theme to apply')

    expect(warnSpy).toHaveBeenCalledWith('[cardinal:site] no theme to apply')
    expect(warnSpy.mock.calls[0]).toHaveLength(1)
  })

  it('forwards every extra argument debug() was given', () => {
    log.debug('graph', 'laid out', { nodes: 12 }, { edges: 30 })

    expect(debugSpy).toHaveBeenCalledWith('[cardinal:graph] laid out', { nodes: 12 }, { edges: 30 })
  })
})

describe('log: the scope list', () => {
  it('is the closed list of 14 the Epic settled on', () => {
    expect(LOG_SCOPES).toEqual([
      'api',
      'auth',
      'page',
      'site',
      'editor',
      'collab',
      'nav',
      'search',
      'graph',
      'dialog',
      'app',
      'analytics',
      'locale',
      'flags'
    ])
  })

  it('complains in development about a scope that is not on it, rather than printing it silently', () => {
    log.warn('nonsense', 'something happened')

    expect(warnSpy).toHaveBeenCalledWith(
      '[cardinal:app] log() called with an unknown scope: nonsense'
    )
    // -> Complains AND still prints: a mistyped scope must never cost the diagnostic itself
    expect(warnSpy).toHaveBeenCalledWith('[cardinal:nonsense] something happened')
  })
})

describe('log: gating', () => {
  it('speaks warn and debug in development with no flag set at all', () => {
    // -> `import.meta.env.DEV` is true under Vitest, which is what lets the suites that count
    //    `console.warn` calls (stores/common.test.js, pages/Graph.keywordSearch.test.js) keep
    //    asserting against the console rather than the helper
    expect(import.meta.env.DEV).toBe(true)
    expect(useFlagsStore().experimental).toBe(false)

    log.warn('app', 'a warning')
    log.debug('app', 'a debug line')

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(debugSpy).toHaveBeenCalledTimes(1)
  })

  it('stays quiet for warn and debug in a production build with the experimental flag off', () => {
    vi.stubEnv('DEV', false)

    log.warn('app', 'a warning')
    log.debug('app', 'a debug line')

    expect(warnSpy).not.toHaveBeenCalled()
    expect(debugSpy).not.toHaveBeenCalled()
  })

  it('speaks for warn and debug in a production build once the experimental flag is on', () => {
    vi.stubEnv('DEV', false)
    useFlagsStore().experimental = true

    log.warn('app', 'a warning')
    log.debug('app', 'a debug line')

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(debugSpy).toHaveBeenCalledTimes(1)
  })

  it('always prints error, flag or no flag, build or no build', () => {
    vi.stubEnv('DEV', false)

    log.error('app', 'something the reader will have noticed')

    expect(errorSpy).toHaveBeenCalledTimes(1)
  })
})

describe('log: resolving the flag safely', () => {
  it('stays quiet rather than throwing when there is no pinia yet', () => {
    vi.stubEnv('DEV', false)
    setActivePinia(undefined)

    expect(() => log.warn('app', 'before boot')).not.toThrow()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(getActivePinia()).toBeUndefined()
  })

  it('reads the flag without instantiating the flags store, so a store that logs cannot recurse', () => {
    vi.stubEnv('DEV', false)
    /*
      `stores/flags.js` is one of the swept files -- it logs through this helper. Were the gate to
      resolve the flag by calling `useFlagsStore()`, that would be a module cycle AND an unbounded
      `shouldSpeak()` -> store setup -> `log.warn` -> `shouldSpeak()` loop. Reading pinia's state tree
      directly closes both: the store is never created on this path.
    */
    const pinia = getActivePinia()
    expect(pinia.state.value.flags).toBeUndefined()

    log.warn('app', 'the flag has never been asked for')

    expect(warnSpy).not.toHaveBeenCalled()
    expect(pinia.state.value.flags).toBeUndefined()
  })

  it('imports nothing from `@/stores`, so no store can import it back into a cycle', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(path.join(here, 'log.js'), 'utf8')

    expect(source).not.toMatch(/from '@\/stores/)
  })
})
