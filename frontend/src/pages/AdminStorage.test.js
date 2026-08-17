import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Regression coverage for the orphaned GitHub App setup flow that used to live in this page
 * (task 509, Feature 372): `setupGitHub()` / `setupGitHubStep()` posted a manifest to
 * github.com and drove a multi-step OAuth+webhook install, but nothing on the backend ever backed
 * it -- no `modules/storage/github/definition.yml` declared the `setup.handler`, no `/_github/*`
 * webhook route existed, so `state.target.setup.handler` could never actually equal `'github'` at
 * runtime and the whole branch (template blocks, JS handlers, the manifest-form ref, and the
 * `GithubSetupInstallDialog.vue` popup) was unreachable dead code. It was removed rather than
 * finished, since a real GitHub App storage module is new 3.0-native scope for its own Feature, not
 * something to half-build inside this git-parity task.
 *
 * These assertions read the page's source text directly rather than mounting it: `AdminStorage.vue`
 * pulls in a v-network-graph delivery-path diagram, the admin/site stores and live storage-target
 * API calls that no other Admin* page currently has Vitest coverage driving through, so a full mount
 * here would be a disproportionate lift for what is fundamentally a "this dead code must not silently
 * reappear" check.
 */

const pagePath = join(import.meta.dirname, 'AdminStorage.vue')
const pageSource = readFileSync(pagePath, 'utf8')

const localePath = join(import.meta.dirname, '../../../backend/locales/en.json')
const locale = JSON.parse(readFileSync(localePath, 'utf8'))

describe('AdminStorage.vue - GitHub App setup flow removal', () => {
  it('does not reference any of the removed GitHub-specific setup handlers or state', () => {
    for (const removed of [
      'setupGitHub(',
      'setupGitHubStep(',
      'githubSetupForm',
      'state.setupCfg',
      'GithubSetupInstallDialog',
      'handleSetupCallback'
    ]) {
      expect(pageSource).not.toContain(removed)
    }
  })

  it('does not gate any template block on a github setup handler', () => {
    expect(pageSource).not.toMatch(/setup\.handler\s*===\s*[`'"]github[`'"]/)
  })

  it('deleted the GithubSetupInstallDialog.vue component it used to open', () => {
    const dialogPath = join(import.meta.dirname, '../components/GithubSetupInstallDialog.vue')
    expect(existsSync(dialogPath)).toBe(false)
  })

  it('has a locale entry for every admin.storage.* key it still calls t() with', () => {
    const used = new Set(pageSource.match(/admin\.storage\.[A-Za-z0-9]+/g))
    expect(used.size).toBeGreaterThan(0)

    const missing = [...used].filter((key) => !(key in locale))
    expect(missing).toEqual([])
  })
})
