import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('github/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('declares mapGroups as a Boolean defaulting to false, after allowedOrganization', () => {
    const prop = def.props.mapGroups
    assert.ok(prop, 'expected a mapGroups prop')
    assert.equal(prop.type, 'Boolean')
    assert.equal(prop.default, false)
    assert.equal(prop.icon, 'user-groups')
    assert.ok(prop.order > def.props.allowedOrganization.order)
  })

  test('declares no groupsClaim prop, since GitHub reports no group claim', () => {
    assert.equal(def.props.groupsClaim, undefined)
  })

  test('mapGroups hint carries the reconcile rules and the GitHub caveats', () => {
    const hint: string = def.props.mapGroups.hint
    for (const fragment of [
      'every login',
      'Mappable Groups allow-list',
      'guests',
      'Auto Enroll Groups',
      'manage:system',
      'root administrators group',
      'read:org',
      'org/team-slug',
      'approve',
      'Enterprise Server'
    ]) {
      assert.ok(hint.includes(fragment), `expected the hint to mention "${fragment}"`)
    }
  })
})
