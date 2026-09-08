import { readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * OpenProject #2656, extended for the Cobalt aesthetic. Seven surfaces mount Monaco, and every one
 * of them registers the same PAIR of custom themes before it does -- `defineMonacoThemes(monaco, …)`
 * (`helpers/monacoTheme.js`, which registers `cardinaljs` and derives `cardinaljs-cobalt` from it)
 * immediately followed by a `theme: monacoThemeName(<aesthetic>)` in the options it hands
 * `monaco.editor.create` / `createDiffEditor`. Two ids rather than one because Monaco takes plain
 * hex and resolves no CSS custom property, so the aesthetic cannot ride the token layer here and is
 * applied by switching themes instead. The
 * registration is repeated per component rather than done once at boot because any one of them can
 * be the first to mount (a reader may open the history diff without ever having opened an editor),
 * and Monaco's theme registry is global, so re-registering the same id is a no-op rather than a
 * conflict.
 *
 * The pairing is what this gate is for, and it exists because **the failure mode is silent**.
 * `monaco.editor.create({ theme: 'nope' })` against an unregistered id does not throw and logs
 * nothing: Monaco falls back to its own default `vs` theme, so the surface renders as a light,
 * generic editor inside a dark Cardinal shell. Nothing in the build, the type checker or any
 * component's own suite catches that -- Monaco is `vi.mock`ed in all seven of those suites, so a
 * mounted assertion would only ever be checking the mock's recorded arguments against themselves.
 * Reading the source text is what actually verifies the two halves still name the same string.
 *
 * That is also why the rename in #2656 (`wikijs` -> `cardinaljs`, the Cardinal rebrand sweep under
 * Feature #2617) was carved out as its own work package: renaming six of the seven registrations,
 * or a registration without its reference, produces a visual regression with no test and no build
 * error behind it.
 *
 * Three properties, in the order they would break:
 *
 * 1. Every file that references a Monaco theme registers that exact id itself (the pairing).
 * 2. All seven registrations agree on one id, since they are redefining one shared theme.
 * 3. That id is `cardinaljs`, and no `wikijs` theme id survives anywhere under `src/` (the rebrand).
 *
 * `MONACO_SURFACES` is checked against disk first, in the style of `docsBaseGate.test.js`, so a
 * renamed or moved component fails as a missing guard rather than quietly shrinking the scan. A
 * NEW Monaco surface needs no edit here -- properties 1-3 are scanned over the whole tree, and the
 * list is only the floor.
 */
const SRC_ROOT = dirname(fileURLToPath(import.meta.url))

const THEME_IDS = ['cardinaljs', 'cardinaljs-cobalt']

const MONACO_SURFACES = [
  'components/EditorAsciidoc.vue',
  'components/EditorCode.vue',
  'components/EditorMarkdown.vue',
  'components/GlossaryImportDialog.vue',
  'components/PageSaveConflictDialog.vue',
  'composables/monacoDiff.js',
  'pages/InboxReview.vue'
]

/*
  A registration is now the shared helper's call rather than a raw `defineTheme`, and a reference is
  `monacoThemeName(...)` rather than a quoted id -- so both are matched by their call site and
  resolved to the ids `helpers/monacoTheme.js` actually publishes. That indirection is the point:
  the two ids exist in exactly one place, and this gate is what keeps every surface pointing at it
  rather than re-typing a string.
*/
const DEFINE_THEME = /\bdefineMonacoThemes\(\s*monaco\b/g
const THEME_OPTION = /\btheme:\s*monacoThemeName\(/g
const RAW_DEFINE = /monaco\.editor\.defineTheme\(/
const RAW_THEME_OPTION = /\btheme:\s*(['"])(cardinaljs[^'"]*)\1/

/** The ids a file registers or references, given how many call sites it has. */
function idsMatching(source, pattern) {
  return [...source.matchAll(pattern)].flatMap(() => THEME_IDS)
}

/** `[relative/path, registeredIds, referencedIds]` for every source file under `src/`. */
function scanSourceFiles() {
  return listSourceFiles(SRC_ROOT, { skip: (full) => full.endsWith('.test.js') }).map((file) => {
    const source = readFileSync(file, 'utf-8')
    return {
      path: relative(SRC_ROOT, file).split(sep).join('/'),
      registered: idsMatching(source, DEFINE_THEME),
      referenced: idsMatching(source, THEME_OPTION)
    }
  })
}

describe('the Monaco theme id (OpenProject #2656)', () => {
  const scanned = scanSourceFiles()
  const registering = scanned.filter((file) => file.registered.length > 0)

  it('still has every listed Monaco surface on disk, so a rename cannot silently retire the guard', () => {
    const present = new Set(registering.map((file) => file.path))
    expect(MONACO_SURFACES.filter((path) => !present.has(path))).toEqual([])
  })

  it('finds a theme registration in every listed surface and nowhere unaccounted for', () => {
    // -> The floor, not the ceiling: a new Monaco surface may register too, and the per-file
    //    pairing below covers it. What this refuses is the scan finding FEWER than the known seven,
    //    which is how a broken regex would otherwise pass every assertion vacuously.
    expect(registering.length).toBeGreaterThanOrEqual(MONACO_SURFACES.length)
  })

  describe.each(MONACO_SURFACES)('%s', (path) => {
    const file = () => registering.find((candidate) => candidate.path === path)

    it('registers the theme it goes on to reference', () => {
      const { registered, referenced } = file()
      // -> The whole point of the suite. An unregistered id renders Monaco's default theme with
      //    nothing thrown and nothing logged, so this is the only place the mismatch surfaces.
      expect(referenced).not.toEqual([])
      expect([...new Set(referenced)]).toEqual([...new Set(registered)])
    })

    it(`names those themes ${THEME_IDS.join(' and ')}`, () => {
      expect([...new Set(file().registered)]).toEqual(THEME_IDS)
    })

    it('goes through the shared helper rather than naming an id itself', () => {
      const source = readFileSync(join(SRC_ROOT, ...path.split('/')), 'utf-8')
      expect(source, `${path} should register through defineMonacoThemes`).not.toMatch(RAW_DEFINE)
      expect(source, `${path} should reference through monacoThemeName`).not.toMatch(
        RAW_THEME_OPTION
      )
    })
  })

  it('registers the same pair of ids across every surface, since they redefine two shared themes', () => {
    const ids = [...new Set(registering.flatMap((file) => file.registered))]
    expect(ids).toEqual(THEME_IDS)
  })

  it('has no file referencing a Monaco theme it does not register itself', () => {
    const registeredIds = new Set(registering.flatMap((file) => file.registered))
    const orphans = scanned
      .filter((file) => file.registered.length === 0)
      .flatMap((file) =>
        file.referenced.filter((id) => registeredIds.has(id)).map((id) => `${file.path}: ${id}`)
      )
    expect(orphans).toEqual([])
  })

  it('carries no surviving `wikijs` theme id anywhere under src/', () => {
    const survivors = scanned
      .filter((file) =>
        [...file.registered, ...file.referenced].some((id) => id.includes('wikijs'))
      )
      .map((file) => file.path)
    expect(survivors).toEqual([])
  })
})
