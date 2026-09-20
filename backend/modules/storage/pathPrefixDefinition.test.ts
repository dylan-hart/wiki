import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { load } from 'js-yaml'
import { parseModuleProps } from '../../helpers/moduleProps.ts'
import type { ModuleProp } from '../../helpers/moduleProps.ts'
import { validateModuleConfig } from '../../helpers/moduleRegistry.ts'

const TARGETS = [
  { key: 's3', anchor: 'bucket' },
  { key: 'gcs', anchor: 'bucket' },
  { key: 'azure', anchor: 'containerName' }
] as const

async function readProps(key: string): Promise<Record<string, ModuleProp>> {
  const raw = await fs.readFile(new URL(`./${key}/definition.yml`, import.meta.url), 'utf8')
  const parsed = load(raw) as { props: Record<string, any> }
  return parseModuleProps(parsed.props)
}

function visibleIn(prop: ModuleProp, config: Record<string, unknown>): boolean {
  return (prop.if as { key: string; eq: unknown }[]).every((rule) => config[rule.key] === rule.eq)
}

for (const { key, anchor } of TARGETS) {
  describe(`${key} definition / pathPrefix`, () => {
    test('is an optional String defaulting to an empty prefix', async () => {
      const prop = (await readProps(key)).pathPrefix
      assert.ok(prop, 'pathPrefix is declared')
      assert.equal(prop.type, 'string')
      assert.equal(prop.default, '')
      assert.equal(prop.required, false)
      assert.equal(prop.sensitive, false)
      assert.equal(prop.title, 'Path Prefix')
    })

    test('hint names the key layout, the sharing use, and the orphaning on change', async () => {
      const { hint } = (await readProps(key)).pathPrefix!
      assert.match(hint, /<prefix>\/<siteId>\//)
      assert.match(hint, /share/i)
      assert.match(hint, /IAM|access policy/)
      assert.match(hint, /orphan/i)
    })

    test('sits immediately after the bucket/container prop', async () => {
      const props = await readProps(key)
      assert.equal(props.pathPrefix!.order, props[anchor]!.order + 1)
    })

    test('no two props visible at once share an order', async () => {
      const props = await readProps(key)
      const modes = key === 's3' ? ['aws', 'do', 'custom'] : [undefined]
      for (const mode of modes) {
        const orders = Object.values(props)
          .filter((prop) => visibleIn(prop, { mode }))
          .map((prop) => prop.order)
        assert.equal(new Set(orders).size, orders.length, `duplicate order in mode ${mode}`)
      }
    })

    test('a config carrying pathPrefix validates, as does one without it', async () => {
      const props = await readProps(key)
      const opts = { refuseUnknown: true, requiredAndPattern: true, moduleTitle: key }
      assert.equal(validateModuleConfig(props, { pathPrefix: 'wiki/prod' }, opts), null)
      assert.equal(validateModuleConfig(props, { pathPrefix: '' }, opts), null)
      assert.equal(validateModuleConfig(props, {}, opts), null)
      assert.notEqual(validateModuleConfig(props, { pathPrefix: 5 }, opts), null)
    })
  })
}
