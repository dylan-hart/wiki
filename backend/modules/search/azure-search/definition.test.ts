import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { parseModuleProps } from '../../../helpers/moduleProps.ts'

const definitionPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'definition.yml')

/**
 * Pure parse of the `azure-search` module's `definition.yml`, the same way `db/definition.test.ts`
 * covers its sibling: load the YAML, then run `props` through `parseModuleProps`. No `WIKI` global and
 * no Azure resource involved.
 */
describe('search azure-search module definition', () => {
  const raw = fs.readFileSync(definitionPath, 'utf8')
  const parsed = load(raw) as Record<string, any>

  test('declares the fields a SearchEngineDefinition needs', () => {
    assert.equal(parsed.key, 'azure-search')
    assert.equal(parsed.title, 'Azure AI Search')
    assert.equal(typeof parsed.description, 'string')
    assert.ok(parsed.description.length > 0)
    assert.equal(parsed.vendor, 'Microsoft Corporation')
    assert.equal(parsed.website, 'https://azure.microsoft.com/en-us/products/ai-services/ai-search')
  })

  test('declares serviceName, adminApiKey and indexName props', () => {
    const props = parseModuleProps(parsed.props ?? {})

    assert.ok(props.serviceName)
    assert.equal(props.serviceName!.type, 'string')
    assert.equal(props.serviceName!.sensitive, false)

    assert.ok(props.adminApiKey)
    assert.equal(props.adminApiKey!.type, 'string')
    assert.equal(props.adminApiKey!.sensitive, true)

    assert.ok(props.indexName)
    assert.equal(props.indexName!.type, 'string')
    assert.equal(props.indexName!.default, 'wiki')
    assert.equal(props.indexName!.sensitive, false)
  })

  test('orders serviceName, adminApiKey and indexName for display', () => {
    const props = parseModuleProps(parsed.props ?? {})
    const order = Object.entries(props)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([key]) => key)
    assert.deepEqual(order, ['serviceName', 'adminApiKey', 'indexName'])
  })
})
