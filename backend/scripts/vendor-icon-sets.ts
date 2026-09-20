/* eslint-disable no-console -- a one-off generator script: its stdout IS its result, and it runs
   outside a booted `CARDINAL`. */
/*
  Vendors the Tabler icon set from the `@iconify-json/tabler` npm package into
  `assets/icon-sets/tabler.json`, in exactly the shape `models/icons.ts#sideloadFromDataPath` reads.

  Merged here rather than read from the package at runtime: `@iconify-json/tabler` ships icons and
  metadata as two files (`icons.json`, `info.json`), not the single `{ icons, aliases?, info? }` shape
  a sideload file is, so this does that merge once and `sideloadFromDataPath()` reads the result no
  differently than a file an operator dropped in by hand.

  The output is committed so a release needs neither network access nor a build step to have it, and
  a dependency bump shows up as a diff. Compact on purpose — vendored data, where pretty-printing
  would roughly double the size for no benefit. `npm run vendor-icons:check` fails on drift.

  Usage: node scripts/vendor-icon-sets.ts [--check]
*/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IconifyJSON, IconifyInfo } from '@iconify/types'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'assets/icon-sets/tabler.json')
const PACKAGE_DIR = path.join(ROOT, 'node_modules/@iconify-json/tabler')

export function buildVendoredTablerCollection(): IconifyJSON {
  const icons = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'icons.json'), 'utf8'))
  const info: IconifyInfo = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'info.json'), 'utf8'))
  return {
    prefix: icons.prefix,
    width: icons.width,
    height: icons.height,
    icons: icons.icons,
    aliases: icons.aliases,
    info
  }
}

function main(): void {
  const collection = buildVendoredTablerCollection()
  const output = `${JSON.stringify(collection)}\n`
  const checking = process.argv.includes('--check')

  if (checking) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null
    if (current !== output) {
      console.error(
        'assets/icon-sets/tabler.json is out of date with @iconify-json/tabler -- run `npm run vendor-icons`.'
      )
      process.exit(1)
    }
    console.log('assets/icon-sets/tabler.json is up to date.')
    return
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, output)
  console.log(`wrote ${Object.keys(collection.icons).length} icons to ${path.relative(ROOT, OUT)}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
