/* eslint-disable no-console -- a one-off generator script: its stdout IS its result, and it runs
   outside a booted `WIKI`. */
/*
  Vendors the Tabler icon set from the `@iconify-json/tabler` npm package into
  `assets/icon-sets/tabler.json` — a full Iconify collection export in exactly the shape
  `models/icons.ts#sideloadFromDataPath` reads (OpenProject #3043).

  Why vendor a merged file rather than have the runtime path read the npm package directly:
  `@iconify-json/tabler` ships icons and metadata as two separate files (`icons.json`, `info.json`),
  not the single `{ icons, aliases?, info? }` shape a sideload file is — see the vendored-collection
  note on `parseSideloadIconCollection`. This script does that one merge, once, so
  `Icons.init()` -> `sideloadFromDataPath()` reads a plain vendored/exported file no differently
  than one an operator dropped in by hand.

  The output is committed, the same reasoning `frontend/scripts/generate-icons.mjs` documents for its
  own generated file: a real release doesn't need network access or a build step to have it, and a
  diff shows exactly what changed when the dependency is bumped. Compact (no pretty-printing) on
  purpose — this is vendored data, not hand-maintained code, and pretty-printing would roughly double
  its size for no benefit. `npm run vendor-icons:check` fails if it has drifted out of step with the
  installed package.

  Usage: node scripts/vendor-icon-sets.ts [--check]
*/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IconifyJSON, IconifyInfo } from '@iconify/types'

// `path.join(..., '..')` rather than `new URL('../', import.meta.url)` -- see
// `frontend/scripts/generate-icons.mjs`'s own note on why the ambient global `URL` is avoided here.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'assets/icon-sets/tabler.json')
const PACKAGE_DIR = path.join(ROOT, 'node_modules/@iconify-json/tabler')

/**
 * Reads `@iconify-json/tabler`'s `icons.json` + `info.json` and merges them into one full Iconify
 * collection object -- the shape `parseSideloadIconCollection` (and a real
 * `api.iconify.design/<prefix>.json` response) already carries.
 */
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
