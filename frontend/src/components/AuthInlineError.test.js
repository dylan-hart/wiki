import { describe, expect, it } from 'vitest'

import AuthInlineError from './AuthInlineError.vue'

import { mountWithApp } from '../../test/mount.js'

describe('AuthInlineError', () => {
  it('renders the message in a role="alert" region', () => {
    const { wrapper } = mountWithApp(AuthInlineError, { props: { message: 'Bad credentials' } })

    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('Bad credentials')
    expect(alert.classes()).toContain('bg-negative')
  })

  it('renders the caption only when one is given', async () => {
    const { wrapper } = mountWithApp(AuthInlineError, { props: { message: 'Login error' } })
    expect(wrapper.text()).toBe('Login error')

    await wrapper.setProps({ caption: 'Account locked' })
    expect(wrapper.text()).toContain('Login error')
    expect(wrapper.text()).toContain('Account locked')
  })
})
