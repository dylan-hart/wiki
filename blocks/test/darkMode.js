import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The dark-mode suite every block that constructs a `DarkMode` controller gets.
 *
 * What is under test is the controller's behaviour, not any one block's use of it: the class on
 * `<body>` is the app's only source of truth for the theme (`blocks/shared/theme.js`), a shadow root
 * cannot see it, and the controller's job is to mirror it onto the host so `:host([dark])` matches.
 * Ten suites carried a byte-identical copy of that assertion (TEST-F8) and ten more blocks
 * constructed a controller with nothing asserting it worked at all -- one shared suite covers both.
 *
 * The mechanics are the reason this is worth sharing rather than retyping: the controller reacts
 * through a `MutationObserver` callback, which runs as a microtask in jsdom exactly as it does in a
 * real browser, so awaiting one `queueMicrotask` turn plus the block's own `updateComplete` is
 * enough to observe the change -- no fake timers, no polling.
 *
 * `block-diagram` keeps a suite of its own instead of calling this: dark mode there is not a CSS
 * attribute but a real second `_draw()`, since mermaid bakes its colours into the SVG it draws.
 *
 * Helpers only: this file is deliberately NOT named `*.test.js`, so the recursive `.test.js` glob
 * `vitest.config.js` includes never tries to run it as a suite.
 *
 * @param {() => Promise<Element>} mount mounts the block under test, stubbing whatever it needs
 * @param {object} [options]
 * @param {boolean} [options.inverted] mount on a light page and turn dark, rather than the other way
 *   round -- the shape `block-live-data`'s own copy of this suite was written in, kept rather than
 *   flipped so what it asserts is unchanged.
 * @param {boolean} [options.attribute] `false` for a block that constructs its controller with
 *   `{ attribute: false }` (`block-map`, which resolves the theme itself and would find a second
 *   answer on the host misleading) -- the controller's own `isDark` is read instead of the host's
 *   attribute.
 */
export function describeDarkMode(mount, { inverted = false, attribute = true } = {}) {
  const readDark = (el) => (attribute ? el.hasAttribute('dark') : el._darkMode.isDark)

  describe('dark mode', () => {
    beforeEach(() => {
      document.body.classList.remove('body--dark')
    })

    it('follows body--dark on mount and on later toggles, via the shared DarkMode controller', async () => {
      if (inverted) {
        const el = await mount()
        expect(readDark(el)).toBe(false)

        document.body.classList.add('body--dark')
        await settleTheme(el)

        expect(readDark(el)).toBe(true)
        return
      }

      document.body.classList.add('body--dark')
      const el = await mount()

      expect(readDark(el)).toBe(true)

      document.body.classList.remove('body--dark')
      await settleTheme(el)

      expect(readDark(el)).toBe(false)
    })
  })
}

/** One microtask turn for the observer callback, then the re-render it asked the host for. */
async function settleTheme(el) {
  await new Promise((resolve) => queueMicrotask(resolve))
  await el.updateComplete
}
