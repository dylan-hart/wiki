import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WSettingsRow from './WSettingsRow.vue'
import WBtnToggle from './WBtnToggle.vue'
import WInput from './WInput.vue'
import WRange from './WRange.vue'
import WSelect from './WSelect.vue'
import WToggle from './WToggle.vue'
import BlueprintIcon from '@/components/BlueprintIcon.vue'

function mountRow(options = {}) {
  return mount(WSettingsRow, {
    global: { components: { WBtnToggle, WInput, WRange, WSelect, WToggle } },
    ...options
  })
}

describe('WSettingsRow shape', () => {
  it('draws the plate, the label and the control in that order', () => {
    const wrapper = mountRow({
      props: { icon: 'tabler:home', label: 'Site title', hint: 'Shown in the browser tab' },
      slots: { default: '<button class="control">x</button>' }
    })

    const plate = wrapper.find('.blueprint-icon')
    const text = wrapper.find('.w-settings-row__text')
    const control = wrapper.find('.w-settings-row__control')

    expect(plate.exists()).toBe(true)
    expect(text.text()).toContain('Site title')
    expect(control.find('.control').exists()).toBe(true)

    const children = [...wrapper.element.children]
    expect(children.indexOf(plate.element)).toBe(0)
    expect(children.indexOf(text.element)).toBe(1)
    expect(children.indexOf(control.element)).toBe(2)
  })

  it('renders the plate WITHOUT the WItemSection wrapper a WItem row would need', () => {
    const wrapper = mountRow({ props: { icon: 'tabler:home', label: 'Site title' } })

    expect(wrapper.findComponent(BlueprintIcon).props('standalone')).toBe(true)
    // -> `w-item-section--avatar`'s 56px width and 16px trailing gutter would turn the design's
    //    14px gap into 33px. See BlueprintIcon's `standalone` prop.
    expect(wrapper.find('.w-item-section').exists()).toBe(false)
  })

  it('omits the plate entirely for a row with neither an icon nor a code', () => {
    const wrapper = mountRow({ props: { label: 'Site title' } })

    expect(wrapper.findComponent(BlueprintIcon).exists()).toBe(false)
    expect(wrapper.find('.w-settings-row__text').exists()).toBe(true)
  })

  it('draws a code plate when given `text` rather than an icon', () => {
    const wrapper = mountRow({ props: { text: 'EN', label: 'Locale' } })

    expect(wrapper.find('.blueprint-icon__text').text()).toBe('EN')
  })

  it('forwards the indicator and its tooltip text to the plate', () => {
    const wrapper = mountRow({
      props: {
        icon: 'tabler:photo',
        label: 'Site logo',
        indicator: '',
        indicatorText: 'Requires Sharp'
      }
    })

    const plate = wrapper.findComponent(BlueprintIcon)
    expect(plate.props('indicator')).toBe('')
    expect(plate.props('indicatorText')).toBe('Requires Sharp')
    expect(wrapper.find('.w-badge').exists()).toBe(true)
  })
})

describe('WSettingsRow hint', () => {
  it('renders the hint under the label when there is one', () => {
    const wrapper = mountRow({ props: { label: 'Site title', hint: 'Shown in the tab' } })

    const text = wrapper.find('.w-settings-row__text')
    expect(text.find('.w-settings-row__label').text()).toBe('Site title')
    expect(text.find('.w-settings-row__hint').text()).toBe('Shown in the tab')
  })

  it('renders no hint element at all when there is none', () => {
    const wrapper = mountRow({ props: { label: 'Site title' } })

    expect(wrapper.find('.w-settings-row__label').text()).toBe('Site title')
    expect(wrapper.find('.w-settings-row__hint').exists()).toBe(false)
  })

  it('takes label and hint as slots for content that is more than a string', () => {
    const wrapper = mountRow({
      props: { label: 'ignored', hint: 'also ignored' },
      slots: { label: '<em class="l">Site title</em>', hint: '<em class="h">A sentence</em>' }
    })

    expect(wrapper.find('.w-settings-row__label .l').text()).toBe('Site title')
    expect(wrapper.find('.w-settings-row__hint .h').text()).toBe('A sentence')
    expect(wrapper.text()).not.toContain('ignored')
  })
})

/**
 * The five controls the design names, all reusable as-is -- the row's job is only to size and place
 * them at the trailing edge, which is what `controlWidth` selects between.
 */
describe('WSettingsRow control types', () => {
  const cases = [
    {
      name: 'single-line input',
      component: WInput,
      slot: '<w-input model-value="Platform wiki" dense aria-label="Site title" />',
      controlWidth: 'grow'
    },
    {
      name: 'select',
      component: WSelect,
      slot: '<w-select :options="[]" dense aria-label="Content license" />',
      controlWidth: 'grow'
    },
    {
      name: 'toggle',
      component: WToggle,
      slot: '<w-toggle :model-value="true" aria-label="Comments" />',
      controlWidth: 'auto'
    },
    {
      name: 'segmented control',
      component: WBtnToggle,
      slot: '<w-btn-toggle model-value="off" :options="[{ value: \'off\', label: \'Off\' }]" />',
      controlWidth: 'auto'
    },
    {
      name: 'two-handle range',
      component: WRange,
      slot: '<w-range :model-value="{ min: 1, max: 3 }" :min="1" :max="6" markers />',
      controlWidth: 'fixed'
    }
  ]

  it.each(cases)('carries a $name at the trailing edge', ({ component, slot, controlWidth }) => {
    const wrapper = mountRow({
      props: { icon: 'tabler:home', label: 'A setting', controlWidth },
      slots: { default: slot }
    })

    const control = wrapper.find('.w-settings-row__control')
    expect(control.classes()).toContain(`w-settings-row__control--${controlWidth}`)
    expect(control.findComponent(component).exists()).toBe(true)
  })

  it('defaults to the growing width, which is what a field wants', () => {
    const wrapper = mountRow({ props: { label: 'A setting' } })

    expect(wrapper.find('.w-settings-row__control').classes()).toContain(
      'w-settings-row__control--grow'
    )
  })

  it('refuses a control width outside the three the design draws', () => {
    const { validator } = WSettingsRow.props.controlWidth

    expect(validator('grow')).toBe(true)
    expect(validator('auto')).toBe(true)
    expect(validator('fixed')).toBe(true)
    expect(validator('trailing')).toBe(false)
  })
})

describe('WSettingsRow stacked preview', () => {
  it('puts the preview under both the label and the control, not beside either', () => {
    const wrapper = mountRow({
      props: { icon: 'tabler:photo', label: 'Site logo', hint: 'PNG or SVG', controlWidth: 'auto' },
      slots: {
        default: '<button class="upload">Upload</button>',
        preview: '<div class="preview">a preview</div>'
      }
    })

    const body = wrapper.find('.w-settings-row__body')
    expect(body.exists()).toBe(true)

    const head = body.find('.w-settings-row__head')
    expect(head.find('.w-settings-row__text').exists()).toBe(true)
    expect(head.find('.upload').exists()).toBe(true)

    const preview = body.find('.w-settings-row__preview')
    expect(preview.find('.preview').exists()).toBe(true)
    // -> A sibling of the head, so it spans the label and the control alike.
    expect(head.element.nextElementSibling).toBe(preview.element)
  })

  it('top-aligns a stacked row without the caller asking, and centres a plain one', () => {
    const stacked = mountRow({
      props: { label: 'Site logo' },
      slots: { preview: '<div>a preview</div>' }
    })
    expect(stacked.classes()).toContain('w-settings-row--top')

    const plain = mountRow({ props: { label: 'Site title' } })
    expect(plain.classes()).not.toContain('w-settings-row--top')
  })

  it('still top-aligns a plain row when the caller asks for it', () => {
    expect(mountRow({ props: { label: 'A', top: true } }).classes()).toContain(
      'w-settings-row--top'
    )
  })

  it('renders no body wrapper when there is no preview, so the row is three flex children', () => {
    const wrapper = mountRow({ props: { icon: 'tabler:home', label: 'Site title' } })

    expect(wrapper.find('.w-settings-row__body').exists()).toBe(false)
    expect(wrapper.element.children).toHaveLength(3)
  })
})

describe('WSettingsRow element', () => {
  it('is a div by default', () => {
    expect(mountRow({ props: { label: 'A' } }).element.tagName).toBe('DIV')
  })

  /**
   * A switch row is clicked anywhere along its length -- the browser forwards a click on a <label>
   * to the control inside it, which is the whole reason `tag` exists. Unlike `WItem` there is no
   * hover or press tint: the design does not draw one on a settings row.
   */
  it('renders as a label so the whole row toggles the control inside it', () => {
    const wrapper = mountRow({
      props: { tag: 'label', label: 'Comments', controlWidth: 'auto' },
      slots: { default: '<w-toggle :model-value="false" aria-label="Comments" />' }
    })

    expect(wrapper.element.tagName).toBe('LABEL')
    expect(wrapper.findComponent(WToggle).exists()).toBe(true)
  })
})
