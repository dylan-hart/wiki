import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { parseModuleProps } from '../../../helpers/common.ts'

const definitionPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'definition.yml')

/**
 * Pure parse of the `elasticsearch` search module's `definition.yml`, the same way
 * `models/search.ts` reads every module definition off disk: load the YAML, then run `props` through
 * `parseModuleProps`. No `WIKI` global and no network involved.
 */
describe('search elasticsearch module definition', () => {
  const raw = fs.readFileSync(definitionPath, 'utf8')
  const parsed = load(raw) as Record<string, any>

  test('declares the fields a SearchEngineDefinition needs', () => {
    assert.equal(parsed.key, 'elasticsearch')
    assert.equal(parsed.title, 'Elasticsearch')
    assert.equal(typeof parsed.description, 'string')
    assert.ok(parsed.description.length > 0)
    assert.equal(parsed.vendor, 'Elastic')
    assert.equal(parsed.website, 'https://www.elastic.co/products/elasticsearch')
  })

  test('does not declare an apiVersion selector: this module targets one current client major', () => {
    const props = parseModuleProps(parsed.props ?? {})
    assert.equal(props.apiVersion, undefined)
  })

  test('declares the seven remaining 2.5.x fields, minus apiVersion', () => {
    const props = parseModuleProps(parsed.props ?? {})
    assert.deepEqual(
      Object.keys(props).sort(),
      [
        'analyzer',
        'hosts',
        'indexName',
        'sniffInterval',
        'sniffOnStart',
        'tlsCertPath',
        'verifyTLSCertificate'
      ].sort()
    )

    assert.equal(props.hosts!.type, 'string')

    assert.equal(props.verifyTLSCertificate!.type, 'boolean')
    assert.equal(props.verifyTLSCertificate!.default, true)

    assert.equal(props.tlsCertPath!.type, 'string')

    assert.equal(props.indexName!.type, 'string')
    assert.equal(props.indexName!.default, 'wiki')

    assert.equal(props.analyzer!.type, 'string')
    assert.equal(props.analyzer!.default, 'standard')

    assert.equal(props.sniffOnStart!.type, 'boolean')
    assert.equal(props.sniffOnStart!.default, false)

    assert.equal(props.sniffInterval!.type, 'number')
    assert.equal(props.sniffInterval!.default, 0)
  })
})
