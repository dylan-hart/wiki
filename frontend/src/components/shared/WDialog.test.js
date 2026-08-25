import { afterEach, describe, expect, it } from 'vitest'
import { DOMWrapper, mount } from '@vue/test-utils'

import WDialog from './WDialog.vue'

/**
 * OpenProject #1617: `WDialog` gains `labelledBy`/`ariaLabel` props bound on the `role="dialog"`
 * panel, giving every dialog in the app an accessible name. They must be real props rather than
 * fallthrough attributes -- `WDialog` sets `inheritAttrs: false` and binds `$attrs` on the
 * teleport root (`.w-dialog-root`) so it can carry a caller's `class`, and a bare
 * `aria-labelledby`/`aria-label` attribute would land there instead of on the panel.
 *
 * `WDialog` teleports its content to `document.body`, outside `@vue/test-utils`'s own tracked
 * tree, so assertions read the real DOM through a `DOMWrapper(document.body)` -- the same pattern
 * `ApiKeyCreateDialog.test.js` and `GlossaryTermDialog.test.js` use for this component.
 */
afterEach(() => {
  document.body.innerHTML = ''
})

describe('WDialog accessible name', () => {
  it('gives the panel a non-empty accessible name via `labelledBy`, referencing an id in its content', () => {
    mount(WDialog, {
      props: { modelValue: true, labelledBy: 'site-info-heading' },
      slots: {
        default: '<div id="site-info-heading">Site info</div>'
      }
    })

    const body = new DOMWrapper(document.body)
    const panel = body.find('[role="dialog"]')

    expect(panel.attributes('aria-labelledby')).toBe('site-info-heading')

    const referenced = body.find('#site-info-heading')
    expect(referenced.exists()).toBe(true)
    expect(referenced.text().trim().length).toBeGreaterThan(0)
  })

  it('gives the panel a non-empty accessible name via `ariaLabel`', () => {
    mount(WDialog, {
      props: { modelValue: true, ariaLabel: 'Delete page' },
      slots: { default: '<p>Are you sure?</p>' }
    })

    const panel = new DOMWrapper(document.body).find('[role="dialog"]')
    expect(panel.attributes('aria-label')).toBe('Delete page')
    expect(panel.attributes('aria-label').length).toBeGreaterThan(0)
  })

  it('leaves both attributes off the teleport root, only the panel carries them', () => {
    mount(WDialog, {
      props: { modelValue: true, labelledBy: 'some-heading', ariaLabel: 'Some dialog' },
      slots: { default: '<div id="some-heading">Some dialog</div>' }
    })

    const root = new DOMWrapper(document.body).find('.w-dialog-root')
    expect(root.attributes('aria-labelledby')).toBeUndefined()
    expect(root.attributes('aria-label')).toBeUndefined()

    const panel = new DOMWrapper(document.body).find('[role="dialog"]')
    expect(panel.attributes('aria-labelledby')).toBe('some-heading')
    expect(panel.attributes('aria-label')).toBe('Some dialog')
  })

  it('renders neither attribute when the props are unset', () => {
    mount(WDialog, {
      props: { modelValue: true },
      slots: { default: '<p>Content</p>' }
    })

    const panel = new DOMWrapper(document.body).find('[role="dialog"]')
    expect(panel.attributes('aria-labelledby')).toBeUndefined()
    expect(panel.attributes('aria-label')).toBeUndefined()
  })
})
