import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { parseModuleProps } from '../../../helpers/moduleProps.ts'

const definitionPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'definition.yml')

/**
 * Pure parse of the `algolia` search module's `definition.yml`, the same way `models/search.ts` reads
 * every module definition off disk: load the YAML, then run `props` through `parseModuleProps`. No
 * `WIKI` global and no network involved.
 */
describe('search algolia module definition', () => {
  const raw = fs.readFileSync(definitionPath, 'utf8')
  const parsed = load(raw) as Record<string, any>

  test('declares the fields a SearchEngineDefinition needs', () => {
    assert.equal(parsed.key, 'algolia')
    assert.equal(parsed.title, 'Algolia')
    assert.equal(typeof parsed.description, 'string')
    assert.ok(parsed.description.length > 0)
    assert.equal(parsed.vendor, 'Algolia')
    assert.equal(parsed.website, 'https://www.algolia.com')
  })

  test("declares appId, apiKey and indexName, matching 2.5.x's shape", () => {
    const props = parseModuleProps(parsed.props ?? {})

    assert.equal(props.appId!.type, 'string')
    assert.equal(props.appId!.sensitive, false)

    assert.equal(props.apiKey!.type, 'string')
    assert.equal(props.apiKey!.sensitive, true)

    assert.equal(props.indexName!.type, 'string')
    assert.equal(props.indexName!.default, 'wiki')
    assert.equal(props.indexName!.sensitive, false)
  })

  test('requires appId and apiKey, task #556: Algolia cannot function without either', () => {
    const props = parseModuleProps(parsed.props ?? {})

    assert.equal(props.appId!.required, true)
    assert.equal(props.apiKey!.required, true)
    assert.equal(props.indexName!.required, false)
  })
})
