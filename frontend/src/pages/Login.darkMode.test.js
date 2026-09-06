import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

import { useDark } from '@/composables/dark'

import Login from './Login.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2550: `Login.vue`'s `.auth`/`.auth-content` style block paired a dark
 * `background-color` for `.body--dark` with no `color` override, so every plain, colorless `<p>`
 * across all six auth screens sharing this container (login, forgot/reset/change password,
 * register, TFA) inherited the browser-default black text on top of the now-dark background.
 * Separately, `Login.vue`'s own `text-grey-7` subtitle had no `dark:` pairing at all, unlike the
 * identical color elsewhere in the app (`AccountMenu.vue`).
 *
 * OpenProject #2627 took that subtitle off the Material grey entirely -- the design sets it in
 * Cardinal's own secondary tier -- so it is now `.auth-lead` with a tone on each side rather than a
 * `text-grey-7` / `dark:text-white` pair. The claim below is unchanged: whatever tone it takes, the
 * two themes must differ and neither may be the browser default.
 *
 * Mounts the real `Login.vue` page (its `<style lang="scss">` block is unscoped, so it applies
 * globally the same way it does in the app) attached to `document.body` -- required for the
 * `.body--dark <selector>` ancestor combinator to actually match -- and reads real, compiled
 * `getComputedStyle` results rather than asserting the source text contains the right-looking
 * string.
 *
 * A fresh mount per theme, rather than one instance with the theme toggled mid-test: see
 * `EditorWysiwyg.darkMode.test.js` for why (happy-dom returns a stale `getComputedStyle` on a second
 * read of the same element after only the `body` ancestor's class changed, under this suite's real,
 * full-size app stylesheet).
 */

const LOCAL_STRATEGY_WITH_FORGOT = {
  id: 'strat-1',
  activeStrategy: {
    displayName: 'Local',
    selfRegistration: false,
    allowForgotPassword: true,
    strategy: {
      key: 'local',
      useForm: true,
      usernameType: 'email',
      icon: 'local.svg'
    }
  }
}

async function mountForTheme(theme) {
  // -> Through `useDark()`, not a raw `classList` write -- see `EditorWysiwyg.darkMode.test.js` for
  //    why a direct `document.body.classList` write would leave reactive state stale.
  useDark().set(theme === 'dark')

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY_WITH_FORGOT]) })

  const { wrapper } = mountWithApp(Login, {
    attachTo: document.body,
    stores: { site: { id: 'site-1' } }
  })
  await flushPromises()
  await nextTick()

  return wrapper
}

function findButtonByText(wrapper, text) {
  return wrapper.findAll('button').find((b) => b.text() === text)
}

afterEach(() => {
  document.body.classList.remove('body--dark', 'body--light')
})

describe('Login.vue dark mode (OpenProject #2550)', () => {
  it('gives the lead line under the wordmark a legible, theme-distinct color', async () => {
    const lightWrapper = await mountForTheme('light')
    const lightColor = getComputedStyle(lightWrapper.find('.auth-lead').element).color
    lightWrapper.unmount()

    const darkWrapper = await mountForTheme('dark')
    const darkColor = getComputedStyle(darkWrapper.find('.auth-lead').element).color
    darkWrapper.unmount()

    expect(darkColor).not.toBe(lightColor)
    expect(darkColor).not.toBe('rgb(0, 0, 0)')
  })

  it('gives a plain, colorless <p> nested anywhere under .auth-content a legible, theme-distinct color inherited from the container -- not the browser-default black', async () => {
    const lightWrapper = await mountForTheme('light')
    // -> Two form strategies would show the panel's own colorless selector prompt directly; a
    //    single local strategy with `allowForgotPassword` shows a link into the forgot-password
    //    screen instead, whose subtitle (`AuthLoginPanel.vue`) is the same kind of plain, colorless
    //    `<p>` the bug affected everywhere else in the flow -- reached through the same real user
    //    interaction a reader would use, not a synthetic screen switch. `t()` resolves an
    //    untranslated key to the key itself under this suite's i18n (see `test/i18n.js`), so the
    //    button's label is literally the translation key.
    // -> Login.vue's own `<p class="auth-lead">` is always rendered above `<auth-login-panel>`,
    //    so once the screen has switched there are two `<p>`s in document order; the LAST one is
    //    the panel's forgot-password subtitle this assertion is actually after.
    await findButtonByText(lightWrapper, 'auth.forgotPasswordLink').trigger('click')
    await nextTick()
    const lightSubtitle = lightWrapper.findAll('p').at(-1)
    const lightColor = getComputedStyle(lightSubtitle.element).color
    lightWrapper.unmount()

    const darkWrapper = await mountForTheme('dark')
    await findButtonByText(darkWrapper, 'auth.forgotPasswordLink').trigger('click')
    await nextTick()
    const darkSubtitle = darkWrapper.findAll('p').at(-1)
    const darkColor = getComputedStyle(darkSubtitle.element).color
    darkWrapper.unmount()

    expect(darkColor).not.toBe(lightColor)
    expect(darkColor).not.toBe('rgb(0, 0, 0)')
  })
})
