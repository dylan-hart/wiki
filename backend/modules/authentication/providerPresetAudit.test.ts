import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards the Feature 355 / Task 436 audit table (docs/auth-provider-audit.md) against drift.
 * Tasks 437-440 gate on a provider appearing here with `oidc preset` or `oauth2 preset` as its
 * target module before a preset may be built for it — see that doc's "Gate" section.
 *
 * Slack moved from `oauth2` preset to `oidc` preset during Task 440: its description asked for the
 * classification to be re-checked against current Slack docs before writing code, and "Sign in with
 * Slack" turned out to be genuine OIDC now (see the doc's note above the table). Discord was
 * re-checked the same way and stayed OAuth2-only.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const auditDocPath = path.join(__dirname, '..', '..', '..', 'docs', 'auth-provider-audit.md')
const auditDoc = readFileSync(auditDocPath, 'utf-8')

/** provider name (as it appears in the table's leftmost cell) -> expected target-module cell text */
const expectedClassifications: Record<string, string> = {
  Auth0: '`oidc` preset',
  Okta: '`oidc` preset',
  'Microsoft (Azure AD / Entra ID)': '`oidc` preset',
  Keycloak: '`oidc` preset',
  GitLab: '`oidc` preset',
  Twitch: '`oidc` preset',
  Discord: '`oauth2` preset',
  Slack: '`oidc` preset',
  Facebook: 'Deferred',
  Dropbox: 'Deferred',
  RocketChat: 'Deferred',
  Firebase: 'Out of scope'
}

/** Parses the single markdown table in the audit doc into { provider -> [protocol, targetModule, reason] } */
function parseAuditTable(markdown: string): Record<string, string[]> {
  const rows: Record<string, string[]> = {}
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| ---') || line.startsWith('| Provider'))
      continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.length !== 4) continue
    const [provider, ...rest] = cells
    rows[provider] = rest
  }
  return rows
}

describe('auth provider preset audit (Feature 355 / Task 436)', () => {
  const rows = parseAuditTable(auditDoc)

  test('every provider named in the Feature is present in the table', () => {
    for (const provider of Object.keys(expectedClassifications)) {
      assert.ok(provider in rows, `expected "${provider}" to have a row in the audit table`)
    }
  })

  test('each provider is classified with its locked target module', () => {
    for (const [provider, expectedTargetModule] of Object.entries(expectedClassifications)) {
      const [, targetModule] = rows[provider]
      assert.equal(
        targetModule,
        expectedTargetModule,
        `expected ${provider}'s target module to be "${expectedTargetModule}", got "${targetModule}"`
      )
    }
  })

  test('the seven confirmed-OIDC providers are marked OIDC', () => {
    for (const provider of [
      'Auth0',
      'Okta',
      'Microsoft (Azure AD / Entra ID)',
      'Keycloak',
      'GitLab',
      'Twitch',
      'Slack'
    ]) {
      const [protocol] = rows[provider]
      assert.equal(protocol, 'OIDC', `expected ${provider} to be classified OIDC`)
    }
  })

  test('Discord is marked OAuth2-only, not OIDC', () => {
    const [protocol] = rows.Discord
    assert.equal(protocol, 'OAuth2-only', 'expected Discord to be classified OAuth2-only')
  })

  test('Facebook, Dropbox and RocketChat are OAuth2-only and deferred, not targeted by this Feature', () => {
    for (const provider of ['Facebook', 'Dropbox', 'RocketChat']) {
      const [protocol, targetModule] = rows[provider]
      assert.equal(protocol, 'OAuth2-only', `expected ${provider} to be classified OAuth2-only`)
      assert.equal(targetModule, 'Deferred', `expected ${provider} to be marked Deferred`)
    }
  })

  test('Firebase is neither OIDC nor OAuth2-only and is marked out of scope', () => {
    const [protocol, targetModule] = rows.Firebase
    assert.equal(protocol, 'Neither')
    assert.equal(targetModule, 'Out of scope')
  })

  test('no row targets oidc/oauth2 preset work beyond what tasks 437-440 are scoped to build', () => {
    const presetTargetedProviders = Object.entries(rows)
      .filter(
        ([, [, targetModule]]) =>
          targetModule === '`oidc` preset' || targetModule === '`oauth2` preset'
      )
      .map(([provider]) => provider)
    assert.deepEqual(
      new Set(presetTargetedProviders),
      new Set([
        'Auth0',
        'Okta',
        'Microsoft (Azure AD / Entra ID)',
        'Keycloak',
        'GitLab',
        'Twitch',
        'Discord',
        'Slack'
      ])
    )
  })
})
