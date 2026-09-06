import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WSelect from './WSelect.vue'

import { createTestI18n } from '../../../test/i18n.js'

/*
  WSelect's popup is a <w-menu>, which teleports its content to document.body -- outside the
  mounted wrapper's own root -- so option rows are read off `document`, not `wrapper.find()`, once
  opened. WSelect drives `w-menu` through `v-model="isOpen"` (a CONTROLLED menu), so opening it is
  just a matter of triggering WSelect's own `onControlClick`/`open()` -- WMenu never attaches its own
  trigger-click listener in that mode (see the comment in WMenu.vue's onMounted).
*/

function options() {
  return document.querySelectorAll('[role="option"]')
}

/** The actual interactive element -- a <button> (plain) or <div> (useInput) -- not WSelect's own
 * outer wrapper <div class="w-select">, which carries none of the combobox attributes itself. */
function control(wrapper) {
  return wrapper.find('[role="combobox"]')
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('WSelect', () => {
  it('opens the listbox on click and lists every option', async () => {
    const wrapper = mount(WSelect, {
      props: { modelValue: null, options: ['a', 'b', 'c'], ariaLabel: 'Pick one' },
      attachTo: document.body
    })

    await control(wrapper).trigger('click')

    expect(control(wrapper).attributes('aria-expanded')).toBe('true')
    expect(options()).toHaveLength(3)
    expect([...options()].map((el) => el.textContent.trim())).toEqual(['a', 'b', 'c'])
  })

  it('emits the picked value and closes the popup on a single-select click', async () => {
    const wrapper = mount(WSelect, {
      props: { modelValue: null, options: ['a', 'b', 'c'], ariaLabel: 'Pick one' },
      attachTo: document.body
    })
    await control(wrapper).trigger('click')

    options()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('update:modelValue')).toEqual([['b']])
    expect(control(wrapper).attributes('aria-expanded')).toBe('false')
  })

  it('toggles values into and out of an array model when multiple, and stays open', async () => {
    const wrapper = mount(WSelect, {
      props: { modelValue: [], options: ['a', 'b'], multiple: true, ariaLabel: 'Pick some' },
      attachTo: document.body
    })
    await control(wrapper).trigger('click')

    options()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:modelValue')[0]).toEqual([['a']])
    expect(control(wrapper).attributes('aria-expanded')).toBe('true')

    await wrapper.setProps({ modelValue: ['a'] })
    options()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:modelValue')[1]).toEqual([[]])
  })

  it('reads value/label off object options via optionValue/optionLabel, and emits the raw value only with emitValue', async () => {
    const objectOptions = [
      { id: 1, name: 'One' },
      { id: 2, name: 'Two' }
    ]
    const wrapper = mount(WSelect, {
      props: {
        modelValue: null,
        options: objectOptions,
        optionValue: 'id',
        optionLabel: 'name',
        emitValue: true,
        ariaLabel: 'Pick one'
      },
      attachTo: document.body
    })
    await control(wrapper).trigger('click')

    expect([...options()].map((el) => el.textContent.trim())).toEqual(['One', 'Two'])
    options()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('update:modelValue')).toEqual([[2]])
  })

  describe('useChips', () => {
    it('renders the multi-select as removable chips, and removing one updates the model', async () => {
      const wrapper = mount(WSelect, {
        props: {
          modelValue: ['a', 'b'],
          options: ['a', 'b', 'c'],
          multiple: true,
          useChips: true,
          ariaLabel: 'Pick some'
        }
      })

      const chips = wrapper.findAllComponents({ name: 'WChip' })
      expect(chips).toHaveLength(2)

      await chips[0].vm.$emit('remove')

      expect(wrapper.emitted('update:modelValue')).toEqual([[['b']]])
    })
  })

  describe('useInput (filtering)', () => {
    it('narrows the listbox to options whose label matches the typed query, case-insensitively', async () => {
      const wrapper = mount(WSelect, {
        props: {
          modelValue: null,
          options: ['Apple', 'Banana', 'Apricot'],
          useInput: true,
          ariaLabel: 'Search fruit'
        },
        attachTo: document.body
      })

      await wrapper.find('input').trigger('focus')
      await wrapper.find('input').setValue('ap')

      expect([...options()].map((el) => el.textContent.trim())).toEqual(['Apple', 'Apricot'])
    })

    it('emits `create` for Enter on a query matching no option, when create is enabled', async () => {
      const wrapper = mount(WSelect, {
        props: {
          modelValue: null,
          options: ['Apple'],
          useInput: true,
          create: true,
          ariaLabel: 'Search fruit'
        },
        attachTo: document.body
      })

      await wrapper.find('input').trigger('focus')
      await wrapper.find('input').setValue('Mango')
      await wrapper.find('input').trigger('keydown', { key: 'Enter' })

      expect(wrapper.emitted('create')).toEqual([['Mango']])
    })
  })

  describe('disabled/readonly', () => {
    it('does not open on click while disabled', async () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], disabled: true, ariaLabel: 'Pick one' }
      })

      expect(control(wrapper).attributes('disabled')).toBeDefined()

      await control(wrapper).trigger('click')

      expect(control(wrapper).attributes('aria-expanded')).toBe('false')
    })

    it('does not open on click while readonly', async () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], readonly: true, ariaLabel: 'Pick one' }
      })

      await control(wrapper).trigger('click')

      expect(control(wrapper).attributes('aria-expanded')).toBe('false')
    })
  })

  describe('optionDisable', () => {
    const options = [
      { value: 'md', label: 'Markdown', locked: false },
      { value: 'docx', label: 'Word', locked: true }
    ]

    it('grays out a disabled option but keeps it visible, and click does not select it', async () => {
      const wrapper = mount(WSelect, {
        props: {
          modelValue: null,
          options,
          optionDisable: 'locked',
          ariaLabel: 'Pick a format'
        },
        attachTo: document.body
      })
      await control(wrapper).trigger('click')

      const rows = document.querySelectorAll('[role="option"]')
      expect(rows).toHaveLength(2)
      expect(rows[1].getAttribute('aria-disabled')).toBe('true')

      rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wrapper.vm.$nextTick()

      expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    })

    it('still selects an enabled option normally', async () => {
      const wrapper = mount(WSelect, {
        props: {
          modelValue: null,
          options,
          optionDisable: 'locked',
          emitValue: true,
          ariaLabel: 'Pick a format'
        },
        attachTo: document.body
      })
      await control(wrapper).trigger('click')

      document
        .querySelectorAll('[role="option"]')[0]
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wrapper.vm.$nextTick()

      expect(wrapper.emitted('update:modelValue')).toEqual([['md']])
    })
  })

  describe('validate()', () => {
    function isRequired(v) {
      return (v !== null && v !== undefined && v !== '') || 'Required'
    }

    it('runs rules against the current model and surfaces the failing message', async () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], rules: [isRequired], ariaLabel: 'Pick one' }
      })

      const valid = wrapper.vm.validate()
      await wrapper.vm.$nextTick()

      expect(valid).toBe(false)
      expect(wrapper.text()).toContain('Required')
    })

    it('validates against a value passed explicitly rather than the (stale) prop', () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], rules: [isRequired], ariaLabel: 'Pick one' }
      })

      expect(wrapper.vm.validate('a')).toBe(true)
    })

    it('announces the message from a live region, and the error text replaces the hint in that same node', async () => {
      const wrapper = mount(WSelect, {
        props: {
          modelValue: null,
          options: ['a'],
          hint: 'Pick one',
          rules: [isRequired],
          ariaLabel: 'Pick one'
        }
      })

      const messageEl = wrapper.find('.min-h-5')
      expect(messageEl.attributes('aria-live')).toBe('polite')
      expect(messageEl.attributes('aria-atomic')).toBe('true')
      expect(messageEl.text()).toBe('Pick one')

      wrapper.vm.validate()
      await wrapper.vm.$nextTick()

      // -> Same node, not a second one -- see the matching WInput test for why that matters
      expect(wrapper.findAll('.min-h-5')).toHaveLength(1)
      const messageElAfter = wrapper.find('.min-h-5')
      expect(messageElAfter.attributes('aria-live')).toBe('polite')
      expect(messageElAfter.text()).toBe('Required')
    })
  })

  it('shows an asterisk beside the label when required', () => {
    const wrapper = mount(WSelect, {
      props: { modelValue: null, options: ['a'], label: 'Group', required: true }
    })

    expect(wrapper.text()).toContain('*')
  })

  describe('i18n', () => {
    it('resolves the empty-state label from the dictionary when noOptionsLabel is not overridden', async () => {
      const i18n = createTestI18n({ 'common.select.noOptions': 'Keine Optionen' })
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: [], ariaLabel: 'Pick one' },
        global: { plugins: [i18n] },
        attachTo: document.body
      })

      await control(wrapper).trigger('click')

      expect(document.body.textContent).toContain('Keine Optionen')
    })

    it('still prefers an explicit noOptionsLabel prop over the dictionary', async () => {
      const i18n = createTestI18n({ 'common.select.noOptions': 'Keine Optionen' })
      const wrapper = mount(WSelect, {
        props: {
          modelValue: null,
          options: [],
          ariaLabel: 'Pick one',
          noOptionsLabel: 'Nothing here'
        },
        global: { plugins: [i18n] },
        attachTo: document.body
      })

      await control(wrapper).trigger('click')

      expect(document.body.textContent).toContain('Nothing here')
      expect(document.body.textContent).not.toContain('Keine Optionen')
    })
  })

  describe('autofocus', () => {
    it('focuses the real control (the button) on mount when set', () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], ariaLabel: 'Pick one', autofocus: true },
        attachTo: document.body
      })

      expect(document.activeElement).toBe(control(wrapper).element)
      wrapper.unmount()
    })

    it('focuses the filter input, not the button, for the useInput variant', () => {
      const wrapper = mount(WSelect, {
        props: {
          modelValue: null,
          options: ['a'],
          ariaLabel: 'Pick one',
          useInput: true,
          autofocus: true
        },
        attachTo: document.body
      })

      expect(document.activeElement).toBe(wrapper.find('input').element)
      wrapper.unmount()
    })

    it('leaves focus alone when unset', () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], ariaLabel: 'Pick one' },
        attachTo: document.body
      })

      expect(document.activeElement).not.toBe(control(wrapper).element)
      wrapper.unmount()
    })
  })

  describe('attribute forwarding', () => {
    it('forwards a plain attribute like name to the real control (the button) rather than the wrapper', () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], ariaLabel: 'Pick one' },
        attrs: { name: 'group' }
      })

      expect(control(wrapper).attributes('name')).toBe('group')
      expect(wrapper.element.getAttribute('name')).toBeNull()
    })

    it('forwards a plain attribute to the filter input, for the useInput variant', () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], ariaLabel: 'Pick one', useInput: true },
        attrs: { name: 'group' }
      })

      expect(wrapper.find('input').attributes('name')).toBe('group')
      expect(wrapper.element.getAttribute('name')).toBeNull()
    })

    // -> OpenProject #2715: the useInput branch used to bind $attrs raw onto the <input>, so a
    //    caller's class landed there AND on the wrapper (via root-class), pushing the text off
    //    centre. It must land on the wrapper only, same as the plain variant.
    it('applies a caller class to the wrapper only, not the filter input, for the useInput variant', () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], ariaLabel: 'Pick one', useInput: true },
        attrs: { class: 'mt-4' }
      })

      expect(wrapper.find('input').classes()).not.toContain('mt-4')
      expect(wrapper.classes()).toContain('mt-4')
    })

    it('does not also land a forwarded attribute on the outer control div, for the useInput variant', () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], ariaLabel: 'Pick one', useInput: true },
        attrs: { name: 'group' }
      })

      // -> The useInput control element is the <div> carrying `w-input-control`, distinct from the
      //    <input> inside it that `control()` resolves via role="combobox"
      expect(wrapper.find('.w-input-control').attributes('name')).toBeUndefined()
    })
  })

  describe('validation message live region', () => {
    it('carries aria-live and aria-atomic whenever the message area is shown', () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], ariaLabel: 'Pick one', hint: 'Helper text' }
      })

      const message = wrapper.find('.text-caption')
      expect(message.attributes('aria-live')).toBe('polite')
      expect(message.attributes('aria-atomic')).toBe('true')
    })
  })

  describe('accessible name', () => {
    it('sets aria-label on the control when no label is passed', () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], ariaLabel: 'Pick one' }
      })

      expect(control(wrapper).attributes('aria-label')).toBe('Pick one')
    })

    it('does not set aria-label on the control once a label is passed', () => {
      const wrapper = mount(WSelect, {
        props: { modelValue: null, options: ['a'], label: 'Group', ariaLabel: 'Pick one' }
      })

      expect(control(wrapper).attributes('aria-label')).toBeUndefined()
    })
  })
})
