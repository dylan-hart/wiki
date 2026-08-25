/**
 * Keeps `locales/en.json`'s `blocks.<tag>.*` namespace in step with the `description` / `label` /
 * `hint` strings every block's `component.js` (one per `blocks/block-*` directory) declares on its
 * `static definition`.
 *
 * The 223 strings the metadata half of OpenProject #1624 set out to localize are read straight off
 * the block source with `extractBlockDefinition` — the same AST walk `blocks/rollup.config.mjs`'s
 * `blocksManifest()` plugin uses to build `compiled/blocks.manifest.json` at build time, so "what key
 * exists" can never drift from "what the compiled manifest actually serves". Key convention:
 * `blocks.<tag>.description`, `blocks.<tag>.props.<name>.label`, `blocks.<tag>.props.<name>.hint` —
 * derivable at render time from data the frontend already has (`BlockPickerOverlay.vue` /
 * `BlockPropsForm.vue` resolve exactly these keys, falling back to the raw string on the definition
 * itself when a key doesn't resolve).
 *
 * `--check` (wired into `.github/workflows/quality.yml` alongside `npm run icons:check`) fails when
 * `en.json` has drifted — a block gained/lost a string, or a key's value no longer matches the
 * source — either an orphan key nothing declares any more, or a source string with no key at all.
 * With no flag, writes `en.json` back with the drift resolved: new keys added, orphans removed,
 * changed values updated. The raw string stays in `component.js` either way — this only ever touches
 * `en.json`.
 *
 * Usage: node scripts/blockLocaleKeys.ts [--check]
 */
import fs from 'node:fs'
import path from 'node:path'
import { extractBlockDefinition } from '../helpers/blockDefinition.ts'

const ROOT = path.join(import.meta.dirname, '../..')
const BLOCKS_DIR = path.join(ROOT, 'blocks')
const LOCALE_FILE = path.join(import.meta.dirname, '../locales/en.json')

/** One expected `blocks.*` key, and the raw string it should hold. */
export interface BlockLocaleEntry {
  key: string
  value: string
  /** `component.js` this entry was read from, for error messages. */
  source: string
}

/**
 * Every `blocks.<tag>.*` key implied by the block definitions on disk right now.
 *
 * Reads each block's `component.js` directly (not the compiled manifest, which is build output and
 * may not exist yet in a fresh checkout) via the same `extractBlockDefinition` the backend uses to
 * validate an uploaded custom block's source.
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
      entries.push({
        key: `blocks.${tag}.description`,
        value: definition.description,
        source: componentPath
      })
    }
    for (const prop of definition.props ?? []) {
      if (prop.label) {
        entries.push({
          key: `blocks.${tag}.props.${prop.name}.label`,
          value: prop.label,
          source: componentPath
        })
      }
      if (prop.hint) {
        entries.push({
          key: `blocks.${tag}.props.${prop.name}.hint`,
          value: prop.hint,
          source: componentPath
        })
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

/** Compares the entries the source implies against what `en.json` currently holds. */
export function diffBlockLocaleKeys(
  entries: BlockLocaleEntry[],
  currentStrings: Record<string, string>
): Drift {
  const expectedKeys = new Set(entries.map((entry) => entry.key))
  const missing = entries.filter((entry) => currentStrings[entry.key] !== entry.value)
  const orphaned = Object.keys(currentStrings)
    .filter((key) => key.startsWith('blocks.'))
    // -> `blocks.<tag>.errors.*` is a different namespace this script has no opinion on: those keys
    //    are read straight out of a block's `render()`/lifecycle code by `blocks/shared/i18n.js`
    //    (OpenProject #1638), not off `static definition`, so nothing here can ever derive them --
    //    flagging every one as an orphan on every run would make `--check` permanently red.
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
