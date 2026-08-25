import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import WDate from './WDate.vue'
import { useCommonStore } from '@/stores/common'

/**
 * OpenProject #1604: `WDate.vue`'s month/year header, weekday row and per-day accessible label all
 * called `Temporal.PlainDate#toLocaleString` with the locale argument left off, so the *browser's*
 * locale won, not the app's `commonStore.locale`, and the weekday row was a hardcoded English array
 * on top of that. These are `PlainDate` labels, not instants, so `userStore.formatDateTime` doesn't
 * fit them -- they need the locale passed straight to `toLocaleString` instead.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function mountAt(modelValue, locale) {
  setActivePinia(createPinia())
  const commonStore = useCommonStore()
  commonStore.locale = locale
  return mount(WDate, { props: { modelValue } })
}

describe('WDate: locale-aware calendar labels', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('formats the month/year header in the app locale, not the browser default', () => {
    const en = mountAt('2024-01-15', 'en')
    const de = mountAt('2024-01-15', 'de')

    expect(en.find('.text-body2').text()).toBe('January 2024')
    expect(de.find('.text-body2').text()).toBe('Januar 2024')
  })

  it('derives the weekday header row from the app locale instead of a fixed English array', () => {
    const en = mountAt('2024-01-15', 'en')
    const de = mountAt('2024-01-15', 'de')

    // -> Scoped to the day grid so the prev/next month `w-btn`'s own `aria-hidden` chevron icon
    //    doesn't get swept up too. 2024-01-01 is a Monday, so this month has zero leading blank
    //    cells (also `aria-hidden`) ahead of the 7 weekday labels -- the first 7 nodes here are the
    //    whole weekday row.
    const enWeekdays = en.find('[role="grid"]').findAll('[aria-hidden="true"]')
    const deWeekdays = de.find('[role="grid"]').findAll('[aria-hidden="true"]')

    expect(enWeekdays.slice(0, 7).map((w) => w.text())).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun'
    ])
    expect(deWeekdays.slice(0, 7).map((w) => w.text())).toEqual([
      'Mo',
      'Di',
      'Mi',
      'Do',
      'Fr',
      'Sa',
      'So'
    ])
  })

  it("localizes each day button's accessible label", () => {
    const en = mountAt('2024-01-15', 'en')
    const de = mountAt('2024-01-15', 'de')

    const enDay15 = en.findAll('.w-date__day').find((w) => w.text() === '15')
    const deDay15 = de.findAll('.w-date__day').find((w) => w.text() === '15')

    expect(enDay15.attributes('aria-label')).toBe('January 15, 2024')
    expect(deDay15.attributes('aria-label')).toBe('15. Januar 2024')
  })

  it('re-renders every locale-dependent label when commonStore.locale changes after mount', async () => {
    setActivePinia(createPinia())
    const commonStore = useCommonStore()
    commonStore.locale = 'en'
    const wrapper = mount(WDate, { props: { modelValue: '2024-01-15' } })

    expect(wrapper.find('.text-body2').text()).toBe('January 2024')

    commonStore.locale = 'de'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.text-body2').text()).toBe('Januar 2024')
  })
})

/**
 * The repo-wide version of this guard (`toLocaleString(undefined` appears under `frontend/src`
 * ONLY at `stores/user.js:29`) belongs to parent Epic #1589 as a whole: two sibling children,
 * #1595 and #1600, each still have their own hand-rolled `toLocaleString(undefined, …)` call sites
 * to convert, on branches not yet merged here. Asserting the full repo-wide invariant from this
 * WP's own branch would fail on files #1604 has no reason to touch. What #1604 owns -- and what
 * this guard actually checks -- is narrower but no less real: `WDate.vue` no longer contributes to
 * that grep, and the one legitimate site, `stores/user.js`'s `formatDatePart` default branch,
 * still stands.
 */
describe('source-scan guard: no locale-less toLocaleString() calls left in WDate.vue', () => {
  // -> Built by concatenation rather than as one literal so this guard's own source line doesn't
  //    trip itself.
  const pattern = 'toLocaleString(' + 'undefined'

  it('WDate.vue no longer calls toLocaleString with the locale argument left off', () => {
    const content = readFileSync(join(SRC_DIR, 'components', 'shared', 'WDate.vue'), 'utf8')

    expect(content).not.toContain(pattern)
  })

  it("leaves the one legitimate site, stores/user.js's formatDatePart default branch, at line 29", () => {
    const lines = readFileSync(join(SRC_DIR, 'stores', 'user.js'), 'utf8').split('\n')
    const hitLines = lines.reduce(
      (acc, line, i) => (line.includes(pattern) ? [...acc, i + 1] : acc),
      []
    )

    expect(hitLines).toEqual([29])
  })
})
