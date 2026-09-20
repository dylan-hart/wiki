import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { load } from 'js-yaml'

import { listSourceFiles } from './sourceFiles.ts'

const MODULES_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'modules')

const ICONIFY_REFERENCE = /^[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$/

const MODULE_LEVEL_ICON = /^(\/_assets\/|https?:\/\/)/

const definitions = listSourceFiles(MODULES_ROOT, { ext: ['.yml'] })
  .filter((file) => path.basename(file) === 'definition.yml')
  .sort()

function nestedIcons(node: unknown, trail: string[], out: { where: string; icon: unknown }[]) {
  if (!node || typeof node !== 'object') {
    return out
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'icon' && trail.length > 0) {
      out.push({ where: trail.join('.'), icon: value })
    } else {
      nestedIcons(value, [...trail, key], out)
    }
  }
  return out
}

describe('module definition.yml icons', () => {
  test('finds the module definitions', () => {
    assert.ok(definitions.length >= 40, `only found ${definitions.length} definition.yml files`)
  })

  for (const file of definitions) {
    const label = path.relative(MODULES_ROOT, file)

    test(`${label}: every prop, action and ref icon is an Iconify reference`, () => {
      const doc = load(readFileSync(file, 'utf8')) as Record<string, unknown>
      const bad = nestedIcons(doc, [], []).filter(
        ({ icon }) => typeof icon !== 'string' || !ICONIFY_REFERENCE.test(icon)
      )
      assert.deepEqual(bad, [])
    })

    test(`${label}: every prop names an icon, so the form has no stand-in glyph to fall back on`, () => {
      const doc = load(readFileSync(file, 'utf8')) as { props?: Record<string, { icon?: unknown }> }
      const missing = Object.entries(doc.props ?? {})
        .filter(([, prop]) => !prop?.icon)
        .map(([key]) => key)
      assert.deepEqual(missing, [])
    })

    test(`${label}: a module-level icon is an asset path, a URL or an Iconify reference`, () => {
      const doc = load(readFileSync(file, 'utf8')) as { icon?: unknown }
      if (doc.icon === undefined) {
        return
      }
      assert.equal(typeof doc.icon, 'string')
      const icon = doc.icon as string
      assert.ok(
        MODULE_LEVEL_ICON.test(icon) || ICONIFY_REFERENCE.test(icon),
        `module-level icon ${icon} is a bare name`
      )
    })
  }
})
