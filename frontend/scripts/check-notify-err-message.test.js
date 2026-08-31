import { describe, test, expect } from 'vitest'
import { findNotifyCalls, findViolations } from './check-notify-err-message.mjs'

describe('findViolations', () => {
  test('flags a bare err.message reaching notify()', () => {
    const src = `
      try {
        await doThing()
      } catch (err) {
        notify({
          type: 'negative',
          message: t('thing.failed'),
          caption: err.message
        })
      }
    `
    const hits = findViolations(src)
    expect(hits).toHaveLength(1)
    expect(hits[0].line).toBe(5)
  })

  test('flags an optional-chained err?.message reaching notify()', () => {
    const src = `notify({ type: 'negative', caption: err?.message })`
    expect(findViolations(src)).toHaveLength(1)
  })

  test('does not flag apiErrorMessage(err) routed through notify()', () => {
    const src = `
      catch (err) {
        notify({
          type: 'negative',
          caption: apiErrorMessage(err)
        })
      }
    `
    expect(findViolations(src)).toHaveLength(0)
  })

  test('does not flag apiErrorMessage(err, fallback) routed through notify()', () => {
    const src = `notify({ caption: apiErrorMessage(err, t('thing.failed')) })`
    expect(findViolations(src)).toHaveLength(0)
  })

  test('does not flag err.message outside of a notify() call, e.g. console.warn', () => {
    const src = `
      console.warn(\`Could not load the site configuration: \${err.message}\`)
      notify({ type: 'negative', message: t('siteConfig.failed') })
    `
    expect(findViolations(src)).toHaveLength(0)
  })

  test('handles a notify() call whose arguments nest further calls, without truncating early', () => {
    const src = `
      notify({
        type: 'negative',
        message: t('thing.failed', { count: 1 }),
        caption: err.message
      })
    `
    expect(findViolations(src)).toHaveLength(1)
  })

  test('flags every violating notify() call in a file, not just the first', () => {
    const src = `
      notify({ caption: err.message })
      notify({ caption: apiErrorMessage(err) })
      notify({ caption: err.message })
    `
    expect(findViolations(src)).toHaveLength(2)
  })

  test('does not flag a file with no notify() calls at all', () => {
    expect(findViolations('const x = err.message')).toHaveLength(0)
  })
})

describe('findNotifyCalls', () => {
  test('extracts the full paren-balanced argument text of each call', () => {
    const src = `notify({ message: t('a', { b: 1 }), caption: apiErrorMessage(err) })`
    const calls = findNotifyCalls(src)
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toContain('apiErrorMessage(err)')
    expect(calls[0].body).toContain("t('a', { b: 1 })")
  })
})
