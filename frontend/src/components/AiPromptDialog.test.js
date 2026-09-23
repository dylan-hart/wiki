import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import AiPromptDialog from './AiPromptDialog.vue'

import { createTestI18n } from '../../test/i18n.js'

let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
})

async function mountDialog(props) {
  const i18n = createTestI18n({
    'editor.aiCursor.expandTitle': 'Expand with AI',
    'editor.aiCursor.expandIntro': 'Expand intro',
    'editor.aiCursor.generateTitle': 'Generate with AI',
    'editor.aiCursor.generateIntro': 'Generate intro',
    'editor.aiCursor.promptLabel': 'Instructions',
    'editor.aiCursor.promptHint': 'Hint',
    'editor.aiCursor.promptRequired': 'Describe what to write.',
    'editor.aiCursor.submit': 'Insert',
    'common.actions.cancel': 'Cancel'
  })
  currentWrapper = mount(AiPromptDialog, {
    props,
    global: { plugins: [i18n] }
  })
  await flushPromises()
  return currentWrapper
}

function textarea() {
  return document.body.querySelector('textarea')
}

function button(label) {
  return [...document.body.querySelectorAll('button')].find((b) => b.textContent.includes(label))
}

describe('AiPromptDialog', () => {
  it('titles itself after the action', async () => {
    await mountDialog({ action: 'generate', required: true })
    expect(document.body.textContent).toContain('Generate with AI')
    currentWrapper.unmount()
    currentWrapper = null

    await mountDialog({ action: 'expand' })
    expect(document.body.textContent).toContain('Expand with AI')
  })

  it('emits the trimmed prompt on submit', async () => {
    const wrapper = await mountDialog({ action: 'generate', required: true })
    const field = textarea()
    field.value = '  Write an intro  '
    field.dispatchEvent(new Event('input'))
    await flushPromises()

    button('Insert').click()
    await flushPromises()

    expect(wrapper.emitted('ok')).toEqual([[{ prompt: 'Write an intro' }]])
  })

  it('refuses an empty prompt when one is required', async () => {
    const wrapper = await mountDialog({ action: 'generate', required: true })

    button('Insert').click()
    await flushPromises()

    expect(wrapper.emitted('ok')).toBeUndefined()
    expect(document.body.textContent).toContain('Describe what to write.')
  })

  it('accepts an empty prompt when it is optional', async () => {
    const wrapper = await mountDialog({ action: 'expand' })

    button('Insert').click()
    await flushPromises()

    expect(wrapper.emitted('ok')).toEqual([[{ prompt: '' }]])
  })

  it('caps the prompt at the route limit', async () => {
    await mountDialog({ action: 'generate', required: true })
    expect(textarea().getAttribute('maxlength')).toBe('2000')
  })

  it('submits on Ctrl+Enter', async () => {
    const wrapper = await mountDialog({ action: 'generate', required: true })
    const field = textarea()
    field.value = 'Go'
    field.dispatchEvent(new Event('input'))
    await flushPromises()

    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
    )
    await flushPromises()

    expect(wrapper.emitted('ok')).toEqual([[{ prompt: 'Go' }]])
  })
})
