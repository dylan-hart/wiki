import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WDate from './WDate.vue'
import { useCommonStore } from '@/stores/common'

function mountCalendar(locale) {
  setActivePinia(createPinia())
  const commonStore = useCommonStore()
  commonStore.locale = locale
  return mount(WDate, { props: { modelValue: '2026-03-15' } })
}

describe('WDate: locale-aware calendar chrome (OpenProject #1604)', () => {
  it('renders the month/year header in the app locale', () => {
    expect(mountCalendar('en').find('.text-body2.font-medium').text()).toBe('March 2026')
    expect(mountCalendar('de').find('.text-body2.font-medium').text()).toBe('März 2026')
  })

  it('renders the weekday row in the app locale, not a hardcoded English array', () => {
    // -> Scoped to the header row's own class, not `[aria-hidden="true"]` alone -- the nav
    //    buttons' chevron icons carry that same attribute and would otherwise be swept in too.
    const enLabels = mountCalendar('en')
      .findAll('.text-center.text-caption')
      .map((w) => w.text())
    expect(enLabels).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])

    const deLabels = mountCalendar('de')
      .findAll('.text-center.text-caption')
      .map((w) => w.text())
    expect(deLabels).toEqual(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'])
  })

  it("renders a day's accessible label in the app locale", () => {
    const enDay15 = mountCalendar('en')
      .findAll('button.w-date__day')
      .find((b) => b.text() === '15')
    expect(enDay15.attributes('aria-label')).toBe('March 15, 2026')

    const deDay15 = mountCalendar('de')
      .findAll('button.w-date__day')
      .find((b) => b.text() === '15')
    expect(deDay15.attributes('aria-label')).toBe('15. März 2026')
  })

  it('re-derives every label when the app locale changes on an already-mounted calendar', async () => {
    setActivePinia(createPinia())
    const commonStore = useCommonStore()
    commonStore.locale = 'en'
    const wrapper = mount(WDate, { props: { modelValue: '2026-03-15' } })

    expect(wrapper.find('.text-body2.font-medium').text()).toBe('March 2026')

    commonStore.locale = 'de'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.text-body2.font-medium').text()).toBe('März 2026')
  })
})

/**
 * OpenProject #1589/#1604: this was the last holdout of the `toLocaleString` + explicit-`undefined`-
 * locale pattern outside the one legitimate site in `stores/user.js`, where the reader's own locale
 * IS the answer -- `formatTimePart`'s zone-labelled branch, which has to format a zoned value
 * directly because the pre-built formatters have no zone to name. Land the repo-wide guard here,
 * next to the fix that closed the last other gap.
 *
 * Asserted by file rather than by `file:line`, so an edit anywhere above it does not fail a guard
 * about where the pattern is used. `*.test.js` is skipped: a test asserting that the app does NOT
 * render the browser default has to build that default to compare against, which is the opposite of
 * the defect this looks for (`stores/user.test.js` does exactly that).
 *
 * The needle is assembled at runtime rather than written as one literal: this file's own source is
 * inside the directory the scan walks, so a literal copy of the pattern here would flag itself.
 */
describe('toLocaleString called with an undefined locale -- source-scan guard', () => {
  it('is used nowhere under frontend/src except the one legitimate site', () => {
    const needle = ['toLocaleString', '(undefined'].join('')
    const srcDir = join(import.meta.dirname, '../..')
    const hits = []

    for (const file of walk(srcDir)) {
      if ((!file.endsWith('.js') && !file.endsWith('.vue')) || file.endsWith('.test.js')) {
        continue
      }
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (line.includes(needle)) {
          hits.push(relative(srcDir, file))
        }
      })
    }

    expect(hits).toEqual(['stores/user.js'])
  })
})

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else {
      yield full
    }
  }
}

/**
 * `labelFor` mirrors `WDate.vue`'s own month-header formatting -- explicit `commonStore.locale`, not
 * an implicit `undefined`, per the guard above.
 */
function labelFor(year, month, locale = 'en') {
  return Temporal.PlainDate.from({ year, month, day: 1 }).toLocaleString(locale, {
    month: 'long',
    year: 'numeric'
  })
}

function monthLabel(wrapper) {
  // `.font-medium` alone also matches the nav buttons (WBtn carries it too, with no text) --
  // `.text-body2` is what narrows this to the actual month label.
  return wrapper.find('.text-body2.font-medium').text()
}

describe('WDate', () => {
  it('moves the visible month to a modelValue set after mount', async () => {
    setActivePinia(createPinia())
    const wrapper = mount(WDate, { props: { modelValue: null } })

    await wrapper.setProps({ modelValue: '2027-03-15' })

    expect(monthLabel(wrapper)).toBe(labelFor(2027, 3))
  })

  it('lets shiftMonth navigate away after the selection re-synced the anchor', async () => {
    setActivePinia(createPinia())
    const wrapper = mount(WDate, { props: { modelValue: '2027-03-15' } })
    expect(monthLabel(wrapper)).toBe(labelFor(2027, 3))

    await wrapper.find('[aria-label="Next month"]').trigger('click')

    expect(monthLabel(wrapper)).toBe(labelFor(2027, 4))
  })

  it('does not yank the view on a range to-only edit', async () => {
    setActivePinia(createPinia())
    const wrapper = mount(WDate, {
      props: { range: true, modelValue: { from: '2027-01-10', to: null } }
    })
    expect(monthLabel(wrapper)).toBe(labelFor(2027, 1))

    // Second click of the two-click cycle: `to` changes, `from` stays put.
    await wrapper.setProps({ modelValue: { from: '2027-01-10', to: '2027-05-20' } })

    expect(monthLabel(wrapper)).toBe(labelFor(2027, 1))
  })

  it('still re-syncs on a range edit that changes from', async () => {
    setActivePinia(createPinia())
    const wrapper = mount(WDate, {
      props: { range: true, modelValue: { from: '2027-01-10', to: '2027-01-20' } }
    })
    expect(monthLabel(wrapper)).toBe(labelFor(2027, 1))

    // A fresh range restarts at a new `from` (see `pick()`'s `!from || to` branch).
    await wrapper.setProps({ modelValue: { from: '2027-06-05', to: null } })

    expect(monthLabel(wrapper)).toBe(labelFor(2027, 6))
  })
})
