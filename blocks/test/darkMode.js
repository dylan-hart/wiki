import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The dark-mode suite every block that constructs a `DarkMode` controller gets. What is under test
 * is the controller's behaviour -- mirroring the `<body>` class a shadow root cannot see onto the
 * host, so `:host([dark])` matches -- not any one block's use of it.
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
 *   round (`block-live-data`).
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

/**
 * One microtask turn for the observer callback -- jsdom runs it as a microtask exactly as a real
 * browser does, so no fake timers and no polling -- then the re-render it asked the host for.
 */
async function settleTheme(el) {
  await new Promise((resolve) => queueMicrotask(resolve))
  await el.updateComplete
}
