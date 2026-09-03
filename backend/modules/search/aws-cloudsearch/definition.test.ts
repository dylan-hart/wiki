import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { parseModuleProps } from '../../../helpers/moduleProps.ts'

const definitionPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'definition.yml')

/**
 * Pure parse of the `aws-cloudsearch` module's `definition.yml`, the same way `azure-search/
 * definition.test.ts` (task #553) covers its sibling: load the YAML, then run `props` through
 * `parseModuleProps`. No `WIKI` global and no AWS credentials involved.
 */
describe('search aws-cloudsearch module definition', () => {
  const raw = fs.readFileSync(definitionPath, 'utf8')
  const parsed = load(raw) as Record<string, any>

  test('declares the fields a SearchEngineDefinition needs', () => {
    assert.equal(parsed.key, 'aws-cloudsearch')
    assert.equal(parsed.title, 'AWS CloudSearch')
    assert.equal(typeof parsed.description, 'string')
    assert.ok(parsed.description.length > 0)
    assert.equal(parsed.vendor, 'Amazon.com, Inc.')
    assert.equal(parsed.website, 'https://aws.amazon.com/cloudsearch/')
  })

  test("declares 2.5.x's six-prop shape", () => {
    const props = parseModuleProps(parsed.props ?? {})

    assert.ok(props.domain)
    assert.equal(props.domain!.type, 'string')
    assert.equal(props.domain!.sensitive, false)

    assert.ok(props.endpoint)
    assert.equal(props.endpoint!.type, 'string')
    assert.equal(props.endpoint!.sensitive, false)

    assert.ok(props.region)
    assert.equal(props.region!.type, 'string')
    assert.equal(props.region!.default, 'us-east-1')
    assert.ok(props.region!.enum)
    assert.equal(props.region!.sensitive, false)

    assert.ok(props.accessKeyId)
    assert.equal(props.accessKeyId!.type, 'string')
    assert.equal(props.accessKeyId!.sensitive, true)

    assert.ok(props.secretAccessKey)
    assert.equal(props.secretAccessKey!.type, 'string')
    assert.equal(props.secretAccessKey!.sensitive, true)

    assert.ok(props.analysisSchemeLang)
    assert.equal(props.analysisSchemeLang!.type, 'string')
    assert.equal(props.analysisSchemeLang!.default, 'en')
    assert.ok(props.analysisSchemeLang!.enum)
    assert.equal(props.analysisSchemeLang!.sensitive, false)
  })

  test("region enum matches 2.5.x's region list, in order", () => {
    const props = parseModuleProps(parsed.props ?? {})
    const values = (props.region!.enum as string[]).map((entry) => entry.split('|')[0])
    assert.deepEqual(values, [
      'ap-northeast-1',
      'ap-northeast-2',
      'ap-southeast-1',
      'ap-southeast-2',
      'eu-central-1',
      'eu-west-1',
      'sa-east-1',
      'us-east-1',
      'us-west-1',
      'us-west-2'
    ])
  })

  test('orders the props for display', () => {
    const props = parseModuleProps(parsed.props ?? {})
    const order = Object.entries(props)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([key]) => key)
    assert.deepEqual(order, [
      'domain',
      'endpoint',
      'region',
      'accessKeyId',
      'secretAccessKey',
      'analysisSchemeLang'
    ])
  })
})
