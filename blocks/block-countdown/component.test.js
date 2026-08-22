import { afterEach, describe, expect, it } from 'vitest'

import './component.js'

// -> Far enough out that "has this already ended" never becomes true for a test run, whichever
//    timezone it resolves against.
const FUTURE_DATE = '2099-01-01T00:00'

/**
 * Appends a `<block-countdown>` with `date`/`timezone` set as properties (mirroring how the picker's
 * attributes reach the element once Lit parses them) and waits for one render.
 */
async function mountCountdown({ date = FUTURE_DATE, timezone } = {}) {
  const el = document.createElement('block-countdown')
  el.date = date
  if (timezone !== undefined) {
    el.timezone = timezone
  }
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

describe('block-countdown', () => {
  afterEach(() => {
    document.body.replaceChildren()
    document.body.className = ''
  })

  /*
    Regression coverage for OpenProject #957/#958: the picker (`blockAttributes` in
    `frontend/src/helpers/blocks.js`) never writes an attribute for a field left at the prop's own
    `default` value, and never writes one for a field cleared to `''` either way -- so the constructor
    default is what an author clearing the Timezone field actually gets. It has to be `''`, matching
    the prop's own default, for "the reader's own timezone when empty" to be reachable at all.
  */
  it('defaults to the reader-local timezone when timezone is never set', async () => {
    const el = await mountCountdown()

    expect(el.timezone).toBe('')
    expect(el._error).toBe('')
    expect(el._target.timeZoneId).toBe(Temporal.Now.timeZoneId())
  })

  it('still honors an explicit UTC timezone', async () => {
    const el = await mountCountdown({ timezone: 'UTC' })

    expect(el._error).toBe('')
    expect(el._target.timeZoneId).toBe('UTC')
  })

  it('honors an explicit IANA timezone', async () => {
    const el = await mountCountdown({ timezone: 'Europe/Paris' })

    expect(el._error).toBe('')
    expect(el._target.timeZoneId).toBe('Europe/Paris')
  })

  it('shows an error for an unrecognised timezone rather than silently falling back', async () => {
    const el = await mountCountdown({ timezone: 'Not/AZone' })

    expect(el._error).toContain('Not/AZone')
    expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
  })
})
