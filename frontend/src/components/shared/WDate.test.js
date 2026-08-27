import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WDate from './WDate.vue'

/** The label the component renders for a given year/month, via the same Temporal formatting. */
function labelFor(year, month) {
  return Temporal.PlainDate.from({ year, month, day: 1 }).toLocaleString(undefined, {
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
    const wrapper = mount(WDate, { props: { modelValue: null } })

    await wrapper.setProps({ modelValue: '2027-03-15' })

    expect(monthLabel(wrapper)).toBe(labelFor(2027, 3))
  })

  it('lets shiftMonth navigate away after the selection re-synced the anchor', async () => {
    const wrapper = mount(WDate, { props: { modelValue: '2027-03-15' } })
    expect(monthLabel(wrapper)).toBe(labelFor(2027, 3))

    await wrapper.find('[aria-label="Next month"]').trigger('click')

    expect(monthLabel(wrapper)).toBe(labelFor(2027, 4))
  })

  it('does not yank the view on a range to-only edit', async () => {
    const wrapper = mount(WDate, {
      props: { range: true, modelValue: { from: '2027-01-10', to: null } }
    })
    expect(monthLabel(wrapper)).toBe(labelFor(2027, 1))

    // Second click of the two-click cycle: `to` changes, `from` stays put.
    await wrapper.setProps({ modelValue: { from: '2027-01-10', to: '2027-05-20' } })

    expect(monthLabel(wrapper)).toBe(labelFor(2027, 1))
  })

  it('still re-syncs on a range edit that changes from', async () => {
    const wrapper = mount(WDate, {
      props: { range: true, modelValue: { from: '2027-01-10', to: '2027-01-20' } }
    })
    expect(monthLabel(wrapper)).toBe(labelFor(2027, 1))

    // A fresh range restarts at a new `from` (see `pick()`'s `!from || to` branch).
    await wrapper.setProps({ modelValue: { from: '2027-06-05', to: null } })

    expect(monthLabel(wrapper)).toBe(labelFor(2027, 6))
  })
})
