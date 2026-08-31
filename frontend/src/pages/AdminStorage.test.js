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

/**
 * WP 1895: `POST .../setup` was one of the nine caller-less API routes (Epic 1867) -- unlike the
 * GitHub App flow above, this is the *generic*, module-agnostic contract (`definition.setup`,
 * `mod.setup`/`setupDestroy`, the `target.setup.state` gate on Enable) that stays regardless of which
 * module eventually implements it, and whose DELETE twin (Uninstall, above) already had a real
 * caller. `runSetupStep()` gives POST one too: a "Start/Continue Setup" row, gated the same way
 * Uninstall is but on the opposite state.
 *
 * Kept to source-text assertions for the same reason the describe block above is: a full mount of
 * this page is a disproportionate lift for what this file already established is not worth it. The
 * actual step-naming logic (`nextSetupStepName`) is unit-tested directly in
 * `helpers/storageSetup.test.js`, with no page mount needed for that part at all.
 */
describe('AdminStorage.vue - storage target setup POST wiring (task 1895)', () => {
  it('gates the whole Setup card on having a handler, not on already being configured', () => {
    const cardOpenTag = pageSource.slice(
      pageSource.indexOf('<w-card class="pb-2 mb-4"'),
      pageSource.indexOf('<w-card-header>')
    )
    expect(cardOpenTag).toContain('v-if="state.target.setup && state.target.setup.handler"')
    expect(cardOpenTag).not.toContain('configured')
  })

  it('renders a Start/Continue Setup row only while setup is not yet configured', () => {
    expect(pageSource).toMatch(/v-if="state\.target\.setup\.state !== `configured`"/)
  })

  it('still renders the Uninstall row only once configured', () => {
    expect(pageSource).toMatch(/v-if="state\.target\.setup\.state === `configured`"/)
  })

  it('runSetupStep() posts to the setup route via the shared step-naming helper', () => {
    expect(pageSource).toContain("import { nextSetupStepName } from '@/helpers/storageSetup'")
    expect(pageSource).toContain('async function runSetupStep()')
    expect(pageSource).toContain('nextSetupStepName(state.target?.setup?.state)')
    expect(pageSource).toMatch(
      /API_CLIENT\.post\(\s*`sites\/\$\{adminStore\.currentSiteId\}\/storage\/targets\/\$\{state\.target\.id\}\/setup`/
    )
  })

  it('reloads the target list after a step completes, rather than guessing the module’s new state', () => {
    const fnBody = pageSource.slice(
      pageSource.indexOf('async function runSetupStep()'),
      pageSource.indexOf('async function setupDestroy()')
    )
    expect(fnBody).toContain('await load()')
  })
})
