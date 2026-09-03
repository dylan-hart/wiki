import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

/**
 * Task 2438: plain Google OIDC has no group claim to reconcile — Workspace group membership needs a
 * separate Admin SDK Directory API call the login flow doesn't make, so (unlike Okta/Azure AD/
 * Keycloak on the generic `oidc` module, or even Discord's caveat-flagged `mapGroups`) this module
 * deliberately carries no `mapGroups`/`groupsClaim`/`groupsScope` props of its own. The actual path
 * to group sync is the SAML module, configured against a custom Google Workspace SAML app -- this
 * guards that the `definition.yml` description still points an admin there, and that nobody
 * resurrects a group-sync prop this module has nothing to back it with.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const definitionPath = path.join(__dirname, 'definition.yml')

function loadDefinition(): Record<string, any> {
  return load(readFileSync(definitionPath, 'utf-8')) as Record<string, any>
}

describe('google auth module definition (Task 2438)', () => {
  test('description points admins needing group sync at the SAML module', () => {
    const definition = loadDefinition()
    assert.match(definition.description, /SAML/)
    assert.match(definition.description.toLowerCase(), /group/)
  })

  test('declares no group-sync props of its own', () => {
    const definition = loadDefinition()
    const propKeys = Object.keys(definition.props ?? {})
    for (const groupProp of ['mapGroups', 'groupsClaim', 'groupsScope']) {
      assert.ok(
        !propKeys.includes(groupProp),
        `expected google/definition.yml not to declare "${groupProp}" -- plain Google OIDC has no groups claim to back it (see the SAML-module pointer in its description instead)`
      )
    }
  })
})
