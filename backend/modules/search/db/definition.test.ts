import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { parseModuleProps } from '../../../helpers/moduleProps.ts'

const definitionPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'definition.yml')

/**
 * Pure parse of the `db` search module's `definition.yml`, the same way `models/storage.ts` and
 * `models/authentication.ts` read every other module definition off disk: load the YAML, then run
 * `props` through `parseModuleProps` (the function that also normalizes `modules/storage/*` and
 * `modules/authentication/*`). No `WIKI` global and no database involved.
 */
describe('search db module definition', () => {
  const raw = fs.readFileSync(definitionPath, 'utf8')
  const parsed = load(raw) as Record<string, any>

  test('declares the fields a SearchEngineDefinition needs', () => {
    assert.equal(parsed.key, 'db')
    assert.equal(parsed.title, 'Database')
    assert.equal(typeof parsed.description, 'string')
    assert.ok(parsed.description.length > 0)
    assert.equal(parsed.vendor, 'Wiki.js')
    assert.equal(parsed.website, 'https://js.wiki')
  })

  test('declares a boolean termHighlighting prop', () => {
    const props = parseModuleProps(parsed.props ?? {})
    assert.ok(props.termHighlighting)
    assert.equal(props.termHighlighting.type, 'boolean')
    assert.equal(props.termHighlighting.default, false)
  })

  test('does not declare dictOverrides as a prop', () => {
    // -> A locale -> dictionary map cannot be expressed by the boolean/number/string/enum props
    //    system (parseModuleProps only handles those), so it must not be declared as one: a prop
    //    declared here would be silently misvalidated by validateConfig's default `typeof !== 'string'`
    //    branch the moment an operator entered an object.
    assert.equal(parsed.props?.dictOverrides, undefined)
  })
})
