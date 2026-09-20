import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { useDark } from '@/composables/dark'
import { usePageStore } from '@/stores/page'

import EditorWysiwyg from './EditorWysiwyg.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * Mounted attached to `document.body`, which the `.body--dark <selector>` ancestor combinator needs
 * to match, and read through the compiled `getComputedStyle` rather than the `<style>` source text.
 *
 * A fresh instance per theme, not one instance toggled mid-test: under the app's real stylesheet,
 * happy-dom's `getComputedStyle` returns a stale value on a second read of the same element when
 * only the `body` ancestor's class changed.
 */
function mountForTheme(theme, content) {
  // -> Through `useDark()`, not a raw `classList` write: `inactiveIconColor` reads the module-level
  //    `dark.isActive` ref, which only this composable updates
  useDark().set(theme === 'dark')

  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = content
  const i18n = createTestI18n()

  return mount(EditorWysiwyg, {
    attachTo: document.body,
    global: { plugins: [i18n] }
  })
}

afterEach(() => {
  document.body.classList.remove('body--dark', 'body--light')
})

describe('EditorWysiwyg.vue dark mode (OpenProject #2498)', () => {
  it("gives the toolbar a distinct background between light and dark, and switches an inactive button's icon color so it stays legible on the dark one", async () => {
    const lightWrapper = mountForTheme('light', 'Hello')
    await nextTick()
    await nextTick()
    const lightToolbar = lightWrapper.find('.wysiwyg-toolbar').element
    const lightBackground = getComputedStyle(lightToolbar).backgroundImage
    // -> `WBtn`'s flat variant writes `color: var(--color-<name>)` inline, so this IS
    //    `inactiveIconColor`'s rendered effect, not an internal read
    // -> The key, not `"Bold"`: `createTestI18n()` seeds no messages, so a title resolves to its own
    //    key string
    const lightBoldColor = lightWrapper.find('[aria-label="editor.wysiwyg.bold"]').element.style
      .color
    lightWrapper.unmount()

    const darkWrapper = mountForTheme('dark', 'Hello')
    await nextTick()
    await nextTick()
    const darkToolbar = darkWrapper.find('.wysiwyg-toolbar').element
    const darkBackground = getComputedStyle(darkToolbar).backgroundImage
    const darkBoldColor = darkWrapper.find('[aria-label="editor.wysiwyg.bold"]').element.style.color
    darkWrapper.unmount()

    expect(lightBackground).toContain('fafafa')
    expect(darkBackground).not.toBe(lightBackground)
    expect(lightBoldColor).toBe('var(--color-grey-10)')
    expect(darkBoldColor).toBe('var(--color-grey-6)')
    expect(darkBoldColor).not.toBe(lightBoldColor)
  })

  it('gives inline code and the blockquote/hr rules a dark variant distinct from light mode', async () => {
    // -> Markdown, not hand-built TipTap JSON: the component always loads `pageStore.content` with
    //    `contentType: 'markdown'`
    const doc = 'Some `inline code`\n\n> Quoted\n\n---'

    const lightWrapper = mountForTheme('light', doc)
    await nextTick()
    await nextTick()
    const lightCode = getComputedStyle(lightWrapper.find('.ProseMirror code').element)
    const lightCodeColor = lightCode.color
    const lightCodeBg = lightCode.backgroundColor
    // -> `borderInlineStartColor`, not `borderLeftColor`: the rule uses the logical form, and
    //    happy-dom tracks logical longhands as their own computed properties rather than resolving
    //    them to the physical property a real browser would
    const lightQuoteBorder = getComputedStyle(
      lightWrapper.find('.ProseMirror blockquote').element
    ).borderInlineStartColor
    const lightHrBorder = getComputedStyle(
      lightWrapper.find('.ProseMirror hr').element
    ).borderTopColor
    lightWrapper.unmount()

    const darkWrapper = mountForTheme('dark', doc)
    await nextTick()
    await nextTick()
    const darkCode = getComputedStyle(darkWrapper.find('.ProseMirror code').element)
    const darkQuoteBorder = getComputedStyle(
      darkWrapper.find('.ProseMirror blockquote').element
    ).borderInlineStartColor
    const darkHrBorder = getComputedStyle(
      darkWrapper.find('.ProseMirror hr').element
    ).borderTopColor
    darkWrapper.unmount()

    expect(darkCode.color).not.toBe(lightCodeColor)
    expect(darkCode.backgroundColor).not.toBe(lightCodeBg)
    expect(darkQuoteBorder).not.toBe(lightQuoteBorder)
    expect(darkHrBorder).not.toBe(lightHrBorder)
  })

  it('gives the empty-editor placeholder text a dark variant distinct from light mode', async () => {
    const lightWrapper = mountForTheme('light', '')
    await nextTick()
    await nextTick()
    const lightColor = getComputedStyle(
      lightWrapper.find('.ProseMirror p.is-editor-empty').element,
      '::before'
    ).color
    lightWrapper.unmount()

    const darkWrapper = mountForTheme('dark', '')
    await nextTick()
    await nextTick()
    const darkColor = getComputedStyle(
      darkWrapper.find('.ProseMirror p.is-editor-empty').element,
      '::before'
    ).color
    darkWrapper.unmount()

    expect(darkColor).not.toBe(lightColor)
  })

  it('gives the table header background and cell borders a dark variant distinct from light mode', async () => {
    const lightWrapper = mountForTheme('light', '')
    await nextTick()
    await nextTick()
    lightWrapper.vm.editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
    await nextTick()
    const lightThBackground = getComputedStyle(
      lightWrapper.find('.ProseMirror th').element
    ).backgroundColor
    const lightBorder = getComputedStyle(lightWrapper.find('.ProseMirror td').element).borderColor
    lightWrapper.unmount()

    const darkWrapper = mountForTheme('dark', '')
    await nextTick()
    await nextTick()
    darkWrapper.vm.editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
    await nextTick()
    const darkThBackground = getComputedStyle(
      darkWrapper.find('.ProseMirror th').element
    ).backgroundColor
    const darkBorder = getComputedStyle(darkWrapper.find('.ProseMirror td').element).borderColor
    darkWrapper.unmount()

    expect(darkThBackground).not.toBe(lightThBackground)
    expect(darkBorder).not.toBe(lightBorder)
  })
})
