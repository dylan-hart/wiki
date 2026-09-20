import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

import { useDark } from '@/composables/dark'

import Login from './Login.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * The claim: every auth screen's text differs between the two themes and neither tone is the
 * unstyled browser default (black on a dark pane). Asserted off real `getComputedStyle` results,
 * with the page attached to `document.body` -- the `.body--dark <selector>` ancestor combinator
 * cannot match otherwise.
 *
 * A fresh mount per theme rather than one instance toggled mid-test: happy-dom returns a stale
 * `getComputedStyle` on a second read of the same element after only the `body` ancestor's class
 * changed.
 *
 * The colors come from `var(--color-*)` properties declared in `css/tailwind.css`, which is not
 * loaded under Vitest, so the four this page reads are seeded by hand with a distinct value per
 * theme.
 */
const TEXT_BODY_COLORS = { light: 'rgb(1, 2, 3)', dark: 'rgb(4, 5, 6)' }
const TEXT_SECONDARY_COLORS = { light: 'rgb(7, 8, 9)', dark: 'rgb(10, 11, 12)' }

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
  // -> Through `useDark()`, not a raw `document.body.classList` write, which would leave the
  //    composable's own reactive state stale.
  useDark().set(theme === 'dark')

  document.documentElement.style.setProperty('--color-text-body', TEXT_BODY_COLORS.light)
  document.documentElement.style.setProperty('--color-text-dark', TEXT_BODY_COLORS.dark)
  document.documentElement.style.setProperty('--color-text-secondary', TEXT_SECONDARY_COLORS.light)
  document.documentElement.style.setProperty(
    '--color-text-secondary-dark',
    TEXT_SECONDARY_COLORS.dark
  )

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
  for (const name of [
    '--color-text-body',
    '--color-text-dark',
    '--color-text-secondary',
    '--color-text-secondary-dark'
  ]) {
    document.documentElement.style.removeProperty(name)
  }
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
    // -> The forgot-password screen's subtitle is a plain, colorless `<p>`, reached through the
    //    same click a reader would make rather than a synthetic screen switch. The button's label
    //    is literally the translation key: this suite's i18n resolves an untranslated key to itself.
    // -> `.auth-lead` sits above `<auth-login-panel>` and stays rendered, so the LAST `<p>` in
    //    document order is the panel's subtitle this assertion is after.
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
