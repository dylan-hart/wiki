import fs, { globSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const IGNORED_DIR_PREFIXES = ['dist/', 'node_modules/']

/**
 * `fs.globSync`'s `exclude` option is a predicate over each matched path, not a list of glob
 * patterns the way the `glob` package's `ignore` was -- this is the equivalent for the two
 * prefixes that mattered here. In practice neither can ever match: every pattern below is already
 * scoped to a `block-*` directory, which `dist` and `node_modules` themselves never are. Kept
 * anyway, so a differently-shaped future pattern does not quietly start reading either directory.
 */
function isIgnoredPath(matchedPath) {
  const posixPath = toPosix(matchedPath)
  return IGNORED_DIR_PREFIXES.some((prefix) => posixPath.startsWith(prefix))
}

/**
 * A path with every `\` turned into a `/`, regardless of platform.
 *
 * `globSync()` results and Rolldown's module `id`s are not guaranteed to be `/`-separated -- on
 * Windows they come back with the platform's own `\`, which every hardcoded `.split('/')` and
 * `.endsWith('/component.js')` below silently never matched, mangling every block's output filename
 * and leaving `blocks.manifest.json` a valid, empty `[]` with no error (confirmed against a real
 * Windows build; see OpenProject #1109). A forward slash never appears inside a single Windows path
 * segment, so this normalization is safe on every platform rather than being a Windows-only branch.
 */
function toPosix(filePath) {
  return filePath.replaceAll('\\', '/')
}

/**
 * Turn an ESTree literal node into a plain JS value.
 *
 * Only literals, arrays and objects of literals are supported — a block definition is metadata, so
 * anything computed is a mistake worth failing the build over.
 */
function literalToValue(node, blockDir) {
  switch (node.type) {
    case 'Literal':
      return node.value
    // A backtick string with nothing interpolated is still a plain value, and the readable way to
    // write the multi-line ones -- a starter body for a block, say.
    case 'TemplateLiteral':
      if (node.expressions.length > 0) {
        throw new Error(
          `${blockDir}: "static definition" must contain only plain literals, got an interpolated template.`
        )
      }
      return node.quasis[0].value.cooked
    case 'ArrayExpression':
      return node.elements.map((el) => literalToValue(el, blockDir))
    case 'ObjectExpression':
      return Object.fromEntries(
        node.properties.map((prop) => [
          prop.key.name ?? prop.key.value,
          literalToValue(prop.value, blockDir)
        ])
      )
    default:
      throw new Error(
        `${blockDir}: "static definition" must contain only plain literals, got ${node.type}.`
      )
  }
}

// -> Exported so `scripts/check-locale-keys.mjs` can read the same "static definition" literals
//    this build does, via `rolldown/parseAst` rather than a second Rolldown build of its own -- see
//    that script's header comment.
export { literalToValue }

const ASSET_MIME_TYPES = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/**
 * Loads a `.css` import as a string, with the files it points at inlined as data URIs.
 *
 * A block styles itself from inside its shadow root, which a `<link>` in the page cannot reach — so a
 * library's stylesheet has to be part of the component. Rolldown's own CSS-bundling pipeline was
 * removed (see `moduleTypes` below), so this plugin is entirely responsible for turning a `.css`
 * import into a JS module.
 *
 * The inlining is what makes that stylesheet's own assets — leaflet's control sprites, KaTeX's font
 * files — arrive with it. A relative `url()` in a stylesheet resolves against the document, not
 * against the file it was written in, so once the CSS is a string inside a bundle those paths point
 * at whatever wiki page happens to be showing the block. There is nowhere to put the files that would
 * fix that: a block is one file served from /_blocks and mounted at a path it does not know.
 *
 * A `@font-face` offering several formats is cut down to its woff2, when it has one. Otherwise the
 * same face arrives three times over — woff2, woff and ttf are the same glyphs at ~1.5x, ~2x and ~4x
 * the bytes — and every browser that can run a block reads woff2.
 */
function cssAsString() {
  return {
    name: 'css-as-string',
    transform(code, id) {
      if (!id.endsWith('.css')) {
        return null
      }
      const baseDir = path.dirname(id)
      // -> Before the inlining, while a `src` list is still short enough to read: a data URI holds
      //    commas of its own, which is exactly what splits the list here.
      const css = code
        .replace(/src\s*:\s*([^;}]+)/g, (declaration, sources) => {
          const parts = sources.split(/,(?![^(]*\))/)
          const woff2 = parts.filter((part) =>
            /\.woff2\b|format\(\s*['"]?woff2['"]?\s*\)/.test(part)
          )
          return woff2.length > 0 && woff2.length < parts.length
            ? `src:${woff2.join(',')}`
            : declaration
        })
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (reference, _quote, target) => {
          // -> Anything already addressable is left alone, `url(#default#VML)` among them: leaflet
          //    writes that one to turn on VML in IE, and it names no file at all.
          if (/^(data:|https?:|\/\/|#|\/)/.test(target)) {
            return reference
          }
          const assetPath = path.resolve(baseDir, target.split(/[?#]/)[0])
          const mimeType = ASSET_MIME_TYPES[path.extname(assetPath).toLowerCase()]
          if (!mimeType || !fs.existsSync(assetPath)) {
            this.warn(`${id}: cannot inline ${target} — no such file, or not a known asset type.`)
            return reference
          }
          this.addWatchFile(assetPath)
          return `url("data:${mimeType};base64,${fs.readFileSync(assetPath).toString('base64')}")`
        })
      return { code: `export default ${JSON.stringify(css)}`, map: { mappings: '' } }
    }
  }
}

/**
 * Collects each block's `static definition` into `compiled/blocks.manifest.json`.
 *
 * The definitions are read from the AST rather than by importing the modules, since a component
 * registers itself with `customElements` on load and so cannot be imported outside a browser.
 *
 * `generateBundle()` sorts by `block` name before serializing: Rolldown parallelizes `transform()`
 * across a Rust thread pool, so the order in which each `component.js` completes -- and therefore the
 * order values land in `definitions` -- is not tied to input file discovery order the way it was
 * under Rollup's effectively single-threaded build of this graph. Without the sort, two consecutive
 * builds of an identical source tree can (and did, during the #3175 spike) produce two different
 * manifest orderings, which is a real loss of the diffable, stable-admin-listing build output the
 * previous rollup-based build had for free.
 */
function blocksManifest() {
  const definitions = new Map()
  // -> How many `block-*/component.js` files exist on disk, known independently of whatever
  //    `transform()` below manages to collect -- generateBundle() compares the two, so a total
  //    collection failure (this task's Windows bug, or a future one just like it) produces a build
  //    error instead of a silently empty manifest.
  let expectedBlockCount = 0
  return {
    name: 'blocks-manifest',
    buildStart() {
      definitions.clear()
      expectedBlockCount = globSync('block-*/component.js', { exclude: isIgnoredPath }).length
    },
    transform(code, id) {
      // -> `path.basename`, not a hardcoded `.endsWith('/component.js')`: a module `id` uses the
      //    platform's own separator, `\` on Windows, which a `/`-literal suffix check never matches
      //    -- see `toPosix`'s doc comment above.
      if (path.basename(id) !== 'component.js') {
        return null
      }
      const blockDir = path.basename(path.dirname(id))
      const ast = this.parse(code)
      for (const node of ast.body) {
        const classNode = node.type === 'ExportNamedDeclaration' ? node.declaration : node
        if (classNode?.type !== 'ClassDeclaration') {
          continue
        }
        const definitionNode = classNode.body.body.find(
          (member) =>
            member.type === 'PropertyDefinition' &&
            member.static &&
            member.key.name === 'definition'
        )
        if (definitionNode) {
          definitions.set(blockDir, literalToValue(definitionNode.value, blockDir))
        }
      }
      if (!definitions.has(blockDir)) {
        this.warn(`${blockDir} has no "static definition" — it will not appear in the admin area.`)
      }
      return null
    },
    generateBundle() {
      // -> A total collection failure looks identical to "there truly are no blocks" once it reaches
      //    here -- the whole reason OpenProject #1109 took real back-and-forth to diagnose. Refusing
      //    to emit a well-formed, empty manifest when block directories plainly exist on disk turns
      //    that into a build error naming the actual problem instead.
      if (definitions.size === 0 && expectedBlockCount > 0) {
        this.error(
          `Found ${expectedBlockCount} block-*/component.js file(s) on disk, but collected zero definitions from them -- blocks.manifest.json would be empty. This usually means the "static definition" extraction above never matched any of them; check transform()'s id handling before assuming there really are no blocks.`
        )
      }
      // -> Sort by `block` (the definition's own tag) rather than by `blockDir`/insertion order --
      //    see this function's doc comment above for why an explicit sort is required under
      //    Rolldown, where it wasn't under Rollup.
      const sorted = [...definitions.values()].sort((a, b) => a.block.localeCompare(b.block))
      this.emitFile({
        type: 'asset',
        fileName: 'blocks.manifest.json',
        source: JSON.stringify(sorted, null, 2) + '\n'
      })
    }
  }
}

/**
 * Copies the runtime data files a block's library fetches for itself into `compiled/<block>/`.
 *
 * Some libraries deliberately keep part of themselves out of the bundle. pdf.js ships its character
 * maps, its fallback fonts, its colour profile and the wasm that decodes JPEG 2000 and JBIG2 images
 * as files it asks for only once a document turns out to need one — several megabytes that would
 * otherwise be carried into every page showing a PDF, to be read by hardly any of them. They still
 * have to be somewhere the browser can ask for them, and for a block that means beside it in
 * /_blocks, since a block knows no other path it can reach.
 *
 * `assets.json` beside a component lists them: a directory to copy — a package subpath, or one
 * starting with `./` for a directory of the block's own — mapped to the name it should have under
 * `compiled/<block>/`. Everything below it is copied, so a block declares four directories rather
 * than two hundred files.
 */
function blockAssets() {
  return {
    name: 'block-assets',
    buildStart() {
      for (const listPath of globSync('block-*/assets.json', { exclude: isIgnoredPath })) {
        // -> `globSync()`'s own result, not a module id -- same Windows-separator hazard as the
        //    `input` map below and `blocksManifest()` above, so normalized the same way.
        const blockDir = toPosix(listPath).split('/')[0]
        this.addWatchFile(listPath)
        const list = JSON.parse(fs.readFileSync(listPath, 'utf8'))
        for (const [source, destination] of Object.entries(list)) {
          const from = source.startsWith('.')
            ? path.resolve(blockDir, source)
            : path.resolve('node_modules', source)
          if (!fs.existsSync(from)) {
            // -> A package that moved its data files between versions, most likely. Silence here
            //    would be a block that loads and then quietly cannot read half the documents it is
            //    given, so the build stops instead.
            this.error(`${listPath}: "${source}" does not exist — nothing to copy from.`)
          }
          for (const entry of fs.readdirSync(from, { recursive: true, withFileTypes: true })) {
            if (!entry.isFile()) {
              continue
            }
            const filePath = path.join(entry.parentPath, entry.name)
            this.emitFile({
              type: 'asset',
              fileName: path.posix.join(
                blockDir,
                destination,
                path.relative(from, filePath).split(path.sep).join('/')
              ),
              source: fs.readFileSync(filePath)
            })
          }
        }
      }
    }
  }
}

/**
 * Prints a raw/gzip/brotli size table for each emitted JS chunk after the build, replacing
 * `rollup-plugin-summary` (single-maintainer, unmaintained for 12+ months, and whose *runtime*
 * dependencies pulled in ~30 transitive packages — including a second `js-yaml` major — for what is
 * purely a console printout nothing else consumes; see OpenProject #3174).
 */
function buildSummary() {
  return {
    name: 'build-summary',
    generateBundle(_options, bundle) {
      const rows = Object.values(bundle)
        .filter((file) => file.type === 'chunk')
        .map((chunk) => {
          const code = Buffer.from(chunk.code, 'utf8')
          return {
            file: chunk.fileName,
            'raw (B)': code.byteLength,
            'gzip (B)': zlib.gzipSync(code).length,
            'brotli (B)': zlib.brotliCompressSync(code).length
          }
        })
        .sort((a, b) => b['raw (B)'] - a['raw (B)'])
      // -> A build with no JS chunks emitted (shouldn't happen, but not this plugin's job to guard
      //    against) would otherwise print an empty, headerless table -- skip it instead.
      if (rows.length > 0) {
        // oxlint-disable-next-line no-console -- build-time size report; this IS its output, same as scripts/**
        console.table(rows)
      }
    }
  }
}

export default {
  input: Object.fromEntries([
    /*
      The entry NAME (this map's key) has to be just the block directory -- Rolldown appends its own
      `.js` on top of whatever name is given, so a name that is the whole mangled path (`fileParts[0]`
      used to be the entire `\`-joined string on Windows, since `.split('/')` never split it) produced
      an output file like `block-checklist\component.js.js` instead of `block-checklist.js`, which the
      runtime loader never asks for. `file` itself -- the entry's VALUE, a real filesystem path
      Rolldown reads with `fs` -- is left in whatever form `globSync()` returned it in; only the name
      derived from it needs normalizing.
    */
    ...globSync('block-*/component.js', { exclude: isIgnoredPath }).map((file) => {
      const fileParts = toPosix(file).split('/')
      return [fileParts[0], file]
    }),
    /*
      A `worker.js` beside a component is a second entry point, compiled to `<block>.worker.js`.

      A web worker is loaded by URL rather than imported, so its code cannot be part of the bundle
      that starts it -- it has to be a file of its own, sitting in /_blocks where the block can point
      at it with `new URL('<block>.worker.js', import.meta.url)`. See `block-pdf`, which runs pdf.js's
      parser off the page's thread.
    */
    ...globSync('block-*/worker.js', { exclude: isIgnoredPath }).map((file) => {
      const fileParts = toPosix(file).split('/')
      return [`${fileParts[0]}.worker`, file]
    })
  ]),
  // -> `platform` is stated rather than left to be inferred, the same rationale the old rollup
  //    config's `resolve({ exportConditions: ['production'] })` had: keeping the `development`
  //    export condition (lit-html's `browser: { development: ..., default: ... }`) out of the
  //    resolved condition set. There is no literal `"production"` condition to opt into the way
  //    `@rollup/plugin-node-resolve` exposed one -- Rolldown's `browser` platform default condition
  //    list (`["import", "browser", "default"]`) simply never includes `development` in the first
  //    place, which has the same effect. `format: 'es'` already implies `platform: 'browser'` by
  //    default, so this is belt-and-braces, matching how the old config over-stated `production`.
  platform: 'browser',
  // -> Rolldown's own CSS-bundling pipeline was removed (rolldown/rolldown#4271) and hard-errors
  //    ("Bundling CSS is no longer supported") on any `.css`-extension module BEFORE a plugin's
  //    `transform` hook gets a chance to rewrite it -- unlike Rollup, which had no opinion about
  //    `.css` at all and deferred entirely to `cssAsString()`'s `transform`. Declaring `.css` as
  //    module type `js` here is what makes Rolldown skip its own CSS handling and hand the raw file
  //    contents to `transform` as a plain (pre-parse) string, the shape `cssAsString()` expects.
  moduleTypes: {
    '.css': 'js'
  },
  // -> `platform: 'browser'` puts `browser` in the resolved condition set, which sends the bare
  //    `import SwaggerUIBundle from 'swagger-ui'` in `block-openapi/component.js` to a DIFFERENT
  //    file than the old rollup config resolved (`exportConditions: ['production']` never requested
  //    `browser`): swagger-ui's own `exports` map picks `dist/swagger-ui-es-bundle-core.js` under
  //    that condition, a non-self-contained ESM build with unresolved bare imports (`base64-js` and
  //    others) meant for a consuming bundler to finish resolving -- it builds and the block registers
  //    cleanly, but a real render throws at runtime (`TypeError: o is not a function`, confirmed by
  //    hand; see the fuller writeup in `block-openapi/component.js`'s own header comment). This alias
  //    pins the resolution back to `dist/swagger-ui-bundle.js`, the self-contained webpack build the
  //    old config used, sidestepping the exports-map condition question for this one package. No
  //    other block in this repo hit an equivalent case -- confirmed by hand for the other named
  //    CJS/UMD-heavy blocks (mermaid -> dayjs in block-diagram, leaflet in block-map), not merely
  //    inferred from this one fix.
  resolve: {
    alias: {
      'swagger-ui': path.resolve('node_modules/swagger-ui/dist/swagger-ui-bundle.js')
    }
  },
  output: {
    dir: 'compiled',
    format: 'es',
    // -> Rolldown's built-in Oxc minifier, replacing `@rollup/plugin-terser`. The old config pinned
    //    `ecma: 2019` for Terser; Rolldown's `MinifyOptions` has no ECMA version target knob to
    //    match. A real-Chromium check across all 26 blocks found no compatibility regression from
    //    this (see docs/decisions/2026-09-14-blocks-bundler-rolldown-spike.md, caveat 5), but the
    //    explicit "output targets ECMA 2019" guarantee the old config stated on purpose is gone, not
    //    silently dropped -- there is currently no equivalent knob to restate it with.
    minify: true
  },
  plugins: [blocksManifest(), blockAssets(), cssAsString(), buildSummary()]
  // -> No plugin for CommonJS interop or Node resolution: both are built into Rolldown. mermaid's
  //    dependency on dayjs (shipped as UMD) is this repo's CJS interop risk case, and it -- along
  //    with every other CommonJS-heavy block (swagger-ui, asciinema-player, pdf.js + its worker) --
  //    was confirmed loading and registering cleanly in real Chromium during the #3175 spike.
}
