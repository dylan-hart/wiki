import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { useDark } from '@/composables/dark'
import { usePageStore } from '@/stores/page'

import EditorWysiwyg from './EditorWysiwyg.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * OpenProject #2498: `EditorWysiwyg.vue`'s `<style>` block had zero `.body--dark` treatment, so its
 * toolbar, table header/borders, inline code, blockquote/hr rules and empty-editor placeholder all
 * stayed hardcoded to their light-mode colors regardless of theme.
 *
 * These mount the real component (its `<style lang="scss">` block is unscoped, so it applies
 * globally the same way it does in the app) attached to `document.body` -- required for the
 * `.body--dark <selector>` ancestor combinator to actually match -- and read the real, compiled
 * `getComputedStyle` result rather than asserting the source text contains the right-looking
 * string.
 *
 * A fresh component instance per theme, rather than one instance with the theme toggled mid-test:
 * happy-dom's `getComputedStyle` was observed under this suite's real, full-size app stylesheet to
 * return a STALE (pre-toggle) value on a *second* read of the *same* element after only the `body`
 * ancestor's class changed -- confirmed as an environment quirk, not a bug in the fix, by reproducing
 * it with a two-rule hand-written stylesheet (where it did NOT reproduce) versus the app's real CSS
 * (where it did). A freshly mounted element, queried exactly once per theme, sidesteps this rather
 * than fighting it.
 */
function mountForTheme(theme, content) {
  // -> Through `useDark()`, not a raw `classList` write: `EditorWysiwyg.vue`'s own
  //    `inactiveIconColor` computed reads the module-level `dark.isActive` ref, which only this
  //    composable's `set()`/`toggle()` update -- a direct `document.body.classList` write changes
  //    what CSS sees but leaves that ref (and so the icon color) stale.
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
    // -> `WBtn.vue`'s flat variant writes `color: var(--color-<name>)` as an inline style for any
    //    button carrying a `color` prop -- this is `inactiveIconColor`'s real, rendered effect, not
    //    an internal read out for the test's own convenience.
    const lightBoldColor = lightWrapper.find('[aria-label="Bold"]').element.style.color
    lightWrapper.unmount()

    const darkWrapper = mountForTheme('dark', 'Hello')
    await nextTick()
    await nextTick()
    const darkToolbar = darkWrapper.find('.wysiwyg-toolbar').element
    const darkBackground = getComputedStyle(darkToolbar).backgroundImage
    const darkBoldColor = darkWrapper.find('[aria-label="Bold"]').element.style.color
    darkWrapper.unmount()

    expect(lightBackground).toContain('fafafa')
    expect(darkBackground).not.toBe(lightBackground)
    expect(lightBoldColor).toBe('var(--color-grey-10)')
    expect(darkBoldColor).toBe('var(--color-grey-6)')
    expect(darkBoldColor).not.toBe(lightBoldColor)
  })

  it('gives inline code and the blockquote/hr rules a dark variant distinct from light mode', async () => {
    const doc = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Some ' },
            { type: 'text', marks: [{ type: 'code' }], text: 'inline code' }
          ]
        },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted' }] }]
        },
        { type: 'horizontalRule' }
      ]
    })

    const lightWrapper = mountForTheme('light', doc)
    await nextTick()
    await nextTick()
    const lightCode = getComputedStyle(lightWrapper.find('.ProseMirror code').element)
    const lightCodeColor = lightCode.color
    const lightCodeBg = lightCode.backgroundColor
    const lightQuoteBorder = getComputedStyle(
      lightWrapper.find('.ProseMirror blockquote').element
    ).borderLeftColor
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
    ).borderLeftColor
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
