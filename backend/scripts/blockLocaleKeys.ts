/* eslint-disable no-console -- a build/CI script: its stdout IS its result, and it runs outside a booted `CARDINAL`. */
/**
 * Keeps `locales/en.json`'s `blocks.<tag>.*` namespace in step with the `description` / `label` /
 * `hint` strings each `blocks/block-*` directory's `component.js` declares on its `static
 * definition`. The keys are read off the block source with `extractBlockDefinition` — the same AST
 * walk `blocks/rollup.config.mjs` builds `compiled/blocks.manifest.json` with — so what keys exist
 * cannot drift from what the compiled manifest serves. Convention: `blocks.<tag>.description`,
 * `blocks.<tag>.props.<name>.label`, `blocks.<tag>.props.<name>.hint`, which the frontend rebuilds at
 * render time, falling back to the raw string on the definition when a key doesn't resolve.
 *
 * `--check` (wired into CI) fails on drift; with no flag the drift is written back into `en.json`.
 * The raw string stays in `component.js` either way.
 *
 * Usage: node scripts/blockLocaleKeys.ts [--check]
 */
import fs from 'node:fs'
import path from 'node:path'
import { extractBlockDefinition } from '../helpers/blockDefinition.ts'

const ROOT = path.join(import.meta.dirname, '../..')
const BLOCKS_DIR = path.join(ROOT, 'blocks')
const LOCALE_FILE = path.join(import.meta.dirname, '../locales/en.json')

export interface BlockLocaleEntry {
  key: string
  value: string
  /** The `component.js` this entry was read from. */
  source: string
}

/**
 * vue-i18n message syntax hazards a block-sourced string can trip. An empty `{}` -- as a literal
 * LaTeX command name like `\\ce{}` mints -- is read as an interpolation placeholder with no
 * identifier and throws a `SyntaxError` out of vue-i18n's message compiler at render time, taking
 * down the whole block picker `v-for` rather than the one card. Deliberately narrow: a well-formed
 * `{identifier}` interpolation (the `blocks.*.errors.*` namespace uses `{url}`, `{path}`, etc.) must
 * keep passing.
 */
const VUE_I18N_HAZARDS: { name: string; test: (value: string) => boolean }[] = [
  { name: 'empty interpolation `{}`', test: (value) => /\{\s*\}/.test(value) },
  {
    name: 'unbalanced `{`/`}`',
    test: (value) => (value.match(/\{/g)?.length ?? 0) !== (value.match(/\}/g)?.length ?? 0)
  },
  { name: 'linked-message `@:` syntax', test: (value) => /@:/.test(value) }
]

export function findVueI18nHazards(value: string): string[] {
  return VUE_I18N_HAZARDS.filter((hazard) => hazard.test(value)).map((hazard) => hazard.name)
}

function assertSafeI18nMessage(value: string, key: string, source: string): void {
  const hazards = findVueI18nHazards(value)
  if (hazards.length > 0) {
    throw new Error(
      `${path.relative(ROOT, source)}: "${key}" is not valid vue-i18n message syntax (${hazards.join(', ')}): ${JSON.stringify(value)}`
    )
  }
}

/**
 * Reads each block's `component.js` directly rather than the compiled manifest, which is build output
 * and may not exist yet in a fresh checkout.
 */
export function collectBlockLocaleEntries(blocksDir = BLOCKS_DIR): BlockLocaleEntry[] {
  const entries: BlockLocaleEntry[] = []
  const blockDirs = fs
    .readdirSync(blocksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('block-'))
    .map((entry) => entry.name)
    .sort()

  for (const blockDir of blockDirs) {
    const componentPath = path.join(blocksDir, blockDir, 'component.js')
    if (!fs.existsSync(componentPath)) {
      continue
    }
    const source = fs.readFileSync(componentPath, 'utf8')
    const result = extractBlockDefinition(source, blockDir)
    if (!result.ok) {
      throw new Error(`${blockDir}: could not read "static definition" — ${result.error.message}`)
    }
    const { definition } = result
    const tag = definition.block
    if (definition.description) {
      const key = `blocks.${tag}.description`
      assertSafeI18nMessage(definition.description, key, componentPath)
      entries.push({ key, value: definition.description, source: componentPath })
    }
    for (const prop of definition.props ?? []) {
      if (prop.label) {
        const key = `blocks.${tag}.props.${prop.name}.label`
        assertSafeI18nMessage(prop.label, key, componentPath)
        entries.push({ key, value: prop.label, source: componentPath })
      }
      if (prop.hint) {
        const key = `blocks.${tag}.props.${prop.name}.hint`
        assertSafeI18nMessage(prop.hint, key, componentPath)
        entries.push({ key, value: prop.hint, source: componentPath })
      }
    }
  }
  return entries
}

interface Drift {
  /** Keys `en.json` is missing, or holds a stale value for. */
  missing: BlockLocaleEntry[]
  /** `blocks.*` keys in `en.json` no source string asks for any more. */
  orphaned: string[]
}

export function diffBlockLocaleKeys(
  entries: BlockLocaleEntry[],
  currentStrings: Record<string, string>
): Drift {
  const expectedKeys = new Set(entries.map((entry) => entry.key))
  const missing = entries.filter((entry) => currentStrings[entry.key] !== entry.value)
  const orphaned = Object.keys(currentStrings)
    .filter((key) => key.startsWith('blocks.'))
    // -> `blocks.<tag>.errors.*` is a different namespace: those keys are read out of a block's own
    //    runtime code by `blocks/shared/i18n.js`, not off `static definition`, so nothing here can
    //    derive them and flagging them as orphans would make `--check` permanently red.
    .filter((key) => !/\.errors\./.test(key))
    .filter((key) => !expectedKeys.has(key))
    .sort()
  return { missing, orphaned }
}

function readLocaleFile(): Record<string, string> {
  return JSON.parse(fs.readFileSync(LOCALE_FILE, 'utf8'))
}

function writeLocaleFile(strings: Record<string, string>): void {
  fs.writeFileSync(LOCALE_FILE, `${JSON.stringify(strings, null, 2)}\n`)
}

function main(): void {
  const entries = collectBlockLocaleEntries()
  const current = readLocaleFile()
  const { missing, orphaned } = diffBlockLocaleKeys(entries, current)

  if (process.argv.includes('--check')) {
    if (missing.length > 0 || orphaned.length > 0) {
      console.error(`locales/en.json is out of date with blocks/block-*/component.js:`)
      for (const entry of missing) {
        console.error(`  missing/stale: ${entry.key}  (${path.relative(ROOT, entry.source)})`)
      }
      for (const key of orphaned) {
        console.error(`  orphaned: ${key}`)
      }
      console.error('Run `npm run block-locale-keys` from backend/ to fix.')
      process.exit(1)
    }
    console.log(`OK  ${entries.length} block locale keys, en.json up to date`)
    return
  }

  const updated = { ...current }
  for (const entry of missing) {
    updated[entry.key] = entry.value
  }
  for (const key of orphaned) {
    delete updated[key]
  }
  writeLocaleFile(updated)
  console.log(
    `wrote ${entries.length} block locale keys to locales/en.json (${missing.length} added/updated, ${orphaned.length} removed)`
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
