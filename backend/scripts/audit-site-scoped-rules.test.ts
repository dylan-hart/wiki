import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findSiteScopedRules,
  formatReportLines,
  type GroupRulesRow
} from './audit-site-scoped-rules.ts'
import type { GroupRule } from '../models/groups.ts'
import { makeGroupRule } from '../test/builders.ts'

const makeRule = makeGroupRule

function makeGroup(overrides: Partial<GroupRulesRow> = {}): GroupRulesRow {
  return {
    id: 'group-1',
    name: 'Editors',
    rules: [],
    ...overrides
  }
}

describe('findSiteScopedRules', () => {
  test('returns nothing when no group has any rules', () => {
    assert.deepEqual(findSiteScopedRules([]), [])
    assert.deepEqual(findSiteScopedRules([makeGroup({ rules: [] })]), [])
  })

  test('skips rules whose sites array is empty', () => {
    const group = makeGroup({ rules: [makeRule({ sites: [] })] })
    assert.deepEqual(findSiteScopedRules([group]), [])
  })

  test('includes a rule whose sites array is non-empty, with the fields the deploying admin needs', () => {
    const group = makeGroup({
      id: 'group-1',
      name: 'Marketing Editors',
      rules: [
        makeRule({
          name: 'Marketing site only',
          sites: ['site-a', 'site-b'],
          roles: ['write:pages', 'manage:pages'],
          mode: 'ALLOW'
        })
      ]
    })
    assert.deepEqual(findSiteScopedRules([group]), [
      {
        groupName: 'Marketing Editors',
        ruleName: 'Marketing site only',
        sites: ['site-a', 'site-b'],
        roles: ['write:pages', 'manage:pages'],
        mode: 'ALLOW'
      }
    ])
  })

  test('reports every matching rule across multiple groups, in encounter order', () => {
    const groupA = makeGroup({
      name: 'Group A',
      rules: [
        makeRule({ name: 'Scoped', sites: ['site-a'] }),
        makeRule({ name: 'Unscoped', sites: [] })
      ]
    })
    const groupB = makeGroup({
      name: 'Group B',
      rules: [makeRule({ name: 'Also scoped', sites: ['site-b'], mode: 'DENY' })]
    })
    const report = findSiteScopedRules([groupA, groupB])
    assert.equal(report.length, 2)
    assert.equal(report[0].groupName, 'Group A')
    assert.equal(report[0].ruleName, 'Scoped')
    assert.equal(report[1].groupName, 'Group B')
    assert.equal(report[1].ruleName, 'Also scoped')
    assert.equal(report[1].mode, 'DENY')
  })

  test('treats a group with a null/missing rules column as having no rules', () => {
    const group = makeGroup({ rules: null as unknown as GroupRule[] })
    assert.deepEqual(findSiteScopedRules([group]), [])
  })
})

describe('formatReportLines', () => {
  test('renders one human-readable line per site-scoped rule', () => {
    const lines = formatReportLines([
      {
        groupName: 'Marketing Editors',
        ruleName: 'Marketing site only',
        sites: ['site-a', 'site-b'],
        roles: ['write:pages'],
        mode: 'ALLOW'
      }
    ])
    assert.equal(lines.length, 1)
    assert.match(lines[0], /Marketing Editors/)
    assert.match(lines[0], /Marketing site only/)
    assert.match(lines[0], /site-a, site-b/)
    assert.match(lines[0], /write:pages/)
    assert.match(lines[0], /ALLOW/)
  })

  test('returns an empty array for an empty report', () => {
    assert.deepEqual(formatReportLines([]), [])
  })
})
