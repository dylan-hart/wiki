import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import BlueprintIcon from './BlueprintIcon.vue'
import ApiKeyCopyDialog from './ApiKeyCopyDialog.vue'

/**
 * Covers #1117: the dialog's `mcpInstallCommand` computed builds a ready-to-paste `claude mcp add`
 * command alongside the raw key, using `window.location.origin` (never a hardcoded host) and
 * `--scope local` (never `project`, which would write the bearer token into a committed `.mcp.json`
 * -- see the component's own doc comment).
 */
function mountDialog(props = {}) {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        admin: { api: { copyKeyTitle: 'Copy API Key', key: 'API Key' } },
        profile: { api: { copyKeyTitle: 'Copy Access Token', key: 'Access Token' } }
      }
    }
  })
  return mount(ApiKeyCopyDialog, {
    props: { keyValue: 'wiki_abc123.def456', ...props },
    global: {
      plugins: [i18n],
      components: { BlueprintIcon }
    }
  })
}

describe('ApiKeyCopyDialog mcp install command', () => {
  const originalOrigin = window.location.origin

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, origin: 'https://wiki.example.com' },
      writable: true
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, origin: originalOrigin },
      writable: true
    })
  })

  it('builds a claude mcp add command with the origin, key, and --scope local', () => {
    const wrapper = mountDialog({ keyValue: 'wiki_abc123.def456' })

    expect(wrapper.vm.mcpInstallCommand).toBe(
      'claude mcp add --transport http wikijs https://wiki.example.com/_mcp ' +
        '--header "Authorization: Bearer wiki_abc123.def456" --scope local'
    )
  })

  it('rebuilds the command when the origin differs', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, origin: 'http://localhost:3000' },
      writable: true
    })

    const wrapper = mountDialog({ keyValue: 'another-key' })

    expect(wrapper.vm.mcpInstallCommand).toContain('http://localhost:3000/_mcp')
    expect(wrapper.vm.mcpInstallCommand).toContain('--scope local')
    expect(wrapper.vm.mcpInstallCommand).not.toContain('--scope project')
  })

  it('copies the install command to the clipboard on copyMcpInstallCommand()', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })

    const wrapper = mountDialog({ keyValue: 'wiki_abc123.def456' })
    await wrapper.vm.copyMcpInstallCommand()

    expect(writeText).toHaveBeenCalledWith(wrapper.vm.mcpInstallCommand)
  })
})

/**
 * OpenProject #2052: the dialog is reused by both the admin API-key form and the user Personal
 * Access Token form via a `labelPrefix` prop, mirroring `ApiKeyRevokeDialog`'s own prop of the same
 * name. Default reproduces the dialog's original, pre-#2052 `admin.api.*` wording exactly.
 */
describe('ApiKeyCopyDialog labelPrefix', () => {
  it('defaults to the admin label namespace, unchanged from before this prop existed', () => {
    const wrapper = mountDialog()

    expect(wrapper.vm.labelPrefix).toBe('admin.api')
    expect(wrapper.vm.t(`${wrapper.vm.labelPrefix}.copyKeyTitle`)).toBe('Copy API Key')
    expect(wrapper.vm.t(`${wrapper.vm.labelPrefix}.key`)).toBe('API Key')
  })

  it('reads its labels from the given prefix, for a personal access token', () => {
    const wrapper = mountDialog({ labelPrefix: 'profile.api' })

    expect(wrapper.vm.t(`${wrapper.vm.labelPrefix}.copyKeyTitle`)).toBe('Copy Access Token')
    expect(wrapper.vm.t(`${wrapper.vm.labelPrefix}.key`)).toBe('Access Token')
  })
})
