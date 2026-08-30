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
 * locale pattern outside the one legitimate site (`stores/user.js`'s `formatDatePart` default branch,
 * where the user explicitly chose "whatever this locale does"). Land the repo-wide guard here, next to
 * the fix that closed the last other gap.
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
      if (!file.endsWith('.js') && !file.endsWith('.vue')) {
        continue
      }
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (line.includes(needle)) {
          hits.push(`${relative(srcDir, file)}:${i + 1}`)
        }
      })
    }

    expect(hits).toEqual(['stores/user.js:29'])
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
