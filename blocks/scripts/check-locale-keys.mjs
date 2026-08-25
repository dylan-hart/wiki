/*
  Checks that every `description:`/`label:`/`hint:` string in a block directory's `component.js`
  `static definition` has a matching `blocks.<tag>.*` key in `backend/locales/en.json`, and that
  `en.json` carries no leftover `blocks.<tag>.*` key for a string that no longer exists on disk.

  Key convention (settled by OpenProject #1628): every piece is derivable at render time from data
  the frontend already has off a resolved block definition and a prop entry, with no separate id to
  keep in sync by hand.

    blocks.<tag>.description                -> definition.description
    blocks.<tag>.props.<propName>.label      -> a props[] entry's .label
    blocks.<tag>.props.<propName>.hint       -> a props[] entry's .hint

  A block/prop that does not declare one of these fields mints no key for it -- BlockPropsForm.vue
  already falls back to `field.name` for a label and skips the hint entirely, so there is nothing to
  translate. The raw string stays in `component.js` as the render-time fallback for when the
  `en.json` dictionary is not loaded (`docs/variances.md:959-964`) -- this script does not remove it,
  only requires a matching key to exist alongside it.

  Definitions are read the same way the real build does -- AST-parsed out of the raw source text via
  `rollup/parseAst`, the same parser Rollup's own plugin API exposes as `this.parse()` -- rather than
  by importing the modules (which register a custom element on load and so cannot run outside a
  browser) or by running a full `rollup -c` build just to read `compiled/blocks.manifest.json` (this
  script has no reason to also resolve, bundle and minify every block's real dependencies). See
  `rollup.config.mjs`'s `blocksManifest()` plugin, whose `literalToValue()` this script imports and
  reuses so the two extraction paths cannot drift apart.

  Usage: node scripts/check-locale-keys.mjs
*/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { globSync } from 'node:fs'
import { parseAst } from 'rollup/parseAst'

import { literalToValue } from '../rollup.config.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const EN_JSON_PATH = path.join(ROOT, '../backend/locales/en.json')

/** Every block directory's `component.js` `static definition`, keyed by its `block` tag. */
function collectDefinitions() {
  const definitions = new Map()
  for (const file of globSync('block-*/component.js', { cwd: ROOT }).sort()) {
    const blockDir = file.split('/')[0]
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const ast = parseAst(code)
    for (const node of ast.body) {
      const classNode = node.type === 'ExportNamedDeclaration' ? node.declaration : node
      if (classNode?.type !== 'ClassDeclaration') {
        continue
      }
      const definitionNode = classNode.body.body.find(
        (member) =>
          member.type === 'PropertyDefinition' && member.static && member.key.name === 'definition'
      )
      if (definitionNode) {
        definitions.set(blockDir, literalToValue(definitionNode.value, blockDir))
      }
    }
  }
  return definitions
}

/** `{ key, expected }` for every string `en.json` must carry, derived from the definitions. */
function expectedKeys(definitions) {
  const expected = []
  for (const definition of definitions.values()) {
    const tag = definition.block
    if (typeof definition.description === 'string') {
      expected.push({ key: `blocks.${tag}.description`, expected: definition.description })
    }
    for (const prop of definition.props ?? []) {
      if (typeof prop.label === 'string') {
        expected.push({
          key: `blocks.${tag}.props.${prop.name}.label`,
          expected: prop.label
        })
      }
      if (typeof prop.hint === 'string') {
        expected.push({ key: `blocks.${tag}.props.${prop.name}.hint`, expected: prop.hint })
      }
    }
  }
  return expected
}

/**
 * Every `en.json` key under the `blocks.` namespace, to its string value.
 *
 * `en.json` is a flat dictionary -- every key is a literal string carrying its own dots (e.g.
 * `"admin.analytics.enabled"`), not a nested object tree, matching how `frontend/src/boot/i18n.js`'s
 * vue-i18n instance is fed it. `blocks.<tag>.*` keys follow that same flat convention.
 */
function flattenBlocksNamespace(enJson) {
  const flat = new Map()
  for (const [key, value] of Object.entries(enJson)) {
    if (key.startsWith('blocks.') && typeof value === 'string') {
      flat.set(key, value)
    }
  }
  return flat
}

function main() {
  const definitions = collectDefinitions()
  const expectedBlockCount = globSync('block-*/component.js', { cwd: ROOT }).length
  if (definitions.size === 0 && expectedBlockCount > 0) {
    console.error(
      `Found ${expectedBlockCount} block-*/component.js file(s) on disk, but collected zero definitions -- the AST extraction above never matched any of them.`
    )
    process.exitCode = 1
    return
  }

  const expected = expectedKeys(definitions)
  const enJson = JSON.parse(fs.readFileSync(EN_JSON_PATH, 'utf8'))
  const actual = flattenBlocksNamespace(enJson)

  const missing = []
  const mismatched = []
  const seen = new Set()
  for (const { key, expected: expectedValue } of expected) {
    seen.add(key)
    if (!actual.has(key)) {
      missing.push(key)
    } else if (actual.get(key) !== expectedValue) {
      mismatched.push({ key, source: expectedValue, enJson: actual.get(key) })
    }
  }
  const orphans = [...actual.keys()].filter((key) => !seen.has(key))

  if (missing.length === 0 && mismatched.length === 0 && orphans.length === 0) {
    console.log(
      `blocks locale keys: ${expected.length} block metadata string(s) all have a matching, up-to-date en.json key.`
    )
    return
  }

  if (missing.length > 0) {
    console.error(`\nMissing en.json key(s) for a component.js string (${missing.length}):`)
    for (const key of missing) {
      console.error(`  - ${key}`)
    }
  }
  if (mismatched.length > 0) {
    console.error(
      `\nen.json key(s) out of sync with their component.js string (${mismatched.length}):`
    )
    for (const { key, source, enJson: enJsonValue } of mismatched) {
      console.error(
        `  - ${key}\n      component.js: ${JSON.stringify(source)}\n      en.json:      ${JSON.stringify(enJsonValue)}`
      )
    }
  }
  if (orphans.length > 0) {
    console.error(
      `\nOrphan en.json key(s) with no matching component.js string (${orphans.length}):`
    )
    for (const key of orphans) {
      console.error(`  - ${key}`)
    }
  }
  console.error(
    '\nEvery blocks.<tag>.* string in en.json must correspond 1:1 to a description/label/hint in a block-*/component.js "static definition" -- see this script\'s header comment for the key convention.'
  )
  process.exitCode = 1
}

main()
