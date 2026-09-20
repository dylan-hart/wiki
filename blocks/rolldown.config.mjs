import fs, { globSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const IGNORED_DIR_PREFIXES = ['dist/', 'node_modules/']

/**
 * `fs.globSync`'s `exclude` is a predicate over each matched path, not a list of glob patterns.
 * Nothing can match it today -- every pattern below is scoped to a `block-*` directory -- but a
 * differently-shaped future pattern would otherwise quietly start reading `dist`/`node_modules`.
 */
function isIgnoredPath(matchedPath) {
  const posixPath = toPosix(matchedPath)
  return IGNORED_DIR_PREFIXES.some((prefix) => posixPath.startsWith(prefix))
}

/**
 * `globSync()` results and Rolldown module `id`s are not guaranteed `/`-separated: on Windows they
 * carry `\`, which every hardcoded `.split('/')` below silently never matches, mangling output
 * filenames and leaving `blocks.manifest.json` a valid, empty `[]` with no error. A forward slash
 * never appears inside a Windows path segment, so normalizing unconditionally is safe everywhere.
 */
function toPosix(filePath) {
  return filePath.replaceAll('\\', '/')
}

/**
 * A block definition is metadata, so anything computed is a mistake worth failing the build over.
 */
function literalToValue(node, blockDir) {
  switch (node.type) {
    case 'Literal':
      return node.value
    // A backtick string with nothing interpolated is still a plain value, and is how the multi-line
    // ones (a block's starter body) are written.
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

// -> Exported so `scripts/check-locale-keys.mjs` reads "static definition" literals exactly the way
//    this build does, without a second Rolldown build of its own.
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
 * A block styles itself from inside its shadow root, which a `<link>` in the page cannot reach, so
 * a library's stylesheet has to become part of the component. Rolldown's own CSS pipeline is gone
 * (see `moduleTypes` below), so this plugin is entirely responsible for that.
 *
 * Its assets are inlined because a relative `url()` resolves against the document, not against the
 * file it was written in: once the CSS is a string inside a bundle, those paths point at whatever
 * page is showing the block, and there is nowhere to put the files that would fix it.
 *
 * A `@font-face` offering several formats is cut down to its woff2 — the same glyphs otherwise
 * arrive three times over, and every browser that can run a block reads woff2.
 */
function cssAsString() {
  return {
    name: 'css-as-string',
    transform(code, id) {
      if (!id.endsWith('.css')) {
        return null
      }
      const baseDir = path.dirname(id)
      // -> Trimmed before the inlining: a data URI holds commas of its own, which is exactly what
      //    splits the `src` list here.
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
          //    writes that one to turn on VML, and it names no file at all.
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
 * Definitions are read from the AST rather than by importing the modules, since a component
 * registers itself with `customElements` on load and so cannot be imported outside a browser.
 *
 * `generateBundle()` sorts by `block` name before serializing: Rolldown parallelizes `transform()`
 * across a thread pool, so the order values land in `definitions` is not the input discovery order,
 * and two builds of an identical tree would otherwise produce two different manifest orderings.
 */
function blocksManifest() {
  const definitions = new Map()
  // -> Counted independently of whatever `transform()` collects, so `generateBundle()` can tell a
  //    total collection failure from a tree that genuinely has no blocks.
  let expectedBlockCount = 0
  return {
    name: 'blocks-manifest',
    buildStart() {
      definitions.clear()
      expectedBlockCount = globSync('block-*/component.js', { exclude: isIgnoredPath }).length
    },
    transform(code, id) {
      // -> `path.basename`, not `.endsWith('/component.js')`: a module `id` uses the platform's own
      //    separator, which a `/`-literal suffix check never matches on Windows.
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
      // -> A total collection failure is indistinguishable from "there truly are no blocks" by the
      //    time it reaches here, and a well-formed empty manifest is the hardest shape to diagnose.
      if (definitions.size === 0 && expectedBlockCount > 0) {
        this.error(
          `Found ${expectedBlockCount} block-*/component.js file(s) on disk, but collected zero definitions from them -- blocks.manifest.json would be empty. This usually means the "static definition" extraction above never matched any of them; check transform()'s id handling before assuming there really are no blocks.`
        )
      }
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
 * Some libraries deliberately keep part of themselves out of the bundle and fetch it at runtime
 * (pdf.js's character maps, fallback fonts and decoder wasm — megabytes hardly any page needs).
 * Those files have to sit beside the block in /_blocks, since a block knows no other reachable path.
 *
 * `assets.json` beside a component maps a directory to copy — a package subpath, or one starting
 * with `./` for the block's own — to its name under `compiled/<block>/`. Everything below it is
 * copied, so a block declares directories rather than hundreds of files.
 */
function blockAssets() {
  return {
    name: 'block-assets',
    buildStart() {
      for (const listPath of globSync('block-*/assets.json', { exclude: isIgnoredPath })) {
        // -> Same Windows-separator hazard `toPosix` exists for
        const blockDir = toPosix(listPath).split('/')[0]
        this.addWatchFile(listPath)
        const list = JSON.parse(fs.readFileSync(listPath, 'utf8'))
        for (const [source, destination] of Object.entries(list)) {
          const from = source.startsWith('.')
            ? path.resolve(blockDir, source)
            : path.resolve('node_modules', source)
          if (!fs.existsSync(from)) {
            // -> Usually a package that moved its data files between versions. Silence here would
            //    ship a block that loads and then cannot read half the documents it is given.
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
      // -> `console.table` on an empty array prints a headerless husk
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
      The entry NAME (this map's key) has to be the block directory alone: Rolldown appends its own
      `.js` to whatever name is given, and the runtime loader asks for `block-<name>.js`. The VALUE
      is a real filesystem path Rolldown reads with `fs`, so it is left exactly as `globSync()`
      returned it -- only the name derived from it needs normalizing.
    */
    ...globSync('block-*/component.js', { exclude: isIgnoredPath }).map((file) => {
      const fileParts = toPosix(file).split('/')
      return [fileParts[0], file]
    }),
    /*
      A worker is loaded by URL rather than imported, so its code cannot be part of the bundle that
      starts it: a `worker.js` beside a component becomes its own entry, sitting in /_blocks where
      the block points at it with `new URL('<block>.worker.js', import.meta.url)`.
    */
    ...globSync('block-*/worker.js', { exclude: isIgnoredPath }).map((file) => {
      const fileParts = toPosix(file).split('/')
      return [`${fileParts[0]}.worker`, file]
    })
  ]),
  // -> Stated rather than inferred from `format: 'es'`: the `browser` platform's condition list
  //    (`["import", "browser", "default"]`) is what keeps lit-html's `development` export condition
  //    out of the resolved set.
  platform: 'browser',
  // -> Rolldown removed its CSS-bundling pipeline (rolldown/rolldown#4271) and now hard-errors on
  //    any `.css` module BEFORE a plugin's `transform` hook can rewrite it. Declaring `.css` as
  //    module type `js` skips that handling and hands `transform` the raw file contents as a
  //    string, which is the shape `cssAsString()` expects.
  moduleTypes: {
    '.css': 'js'
  },
  // -> `platform: 'browser'` puts `browser` in the resolved condition set, and swagger-ui's own
  //    `exports` map answers that with `dist/swagger-ui-es-bundle-core.js`: a non-self-contained
  //    ESM build whose bare imports (`base64-js` and others) a consuming bundler is meant to finish
  //    resolving. It builds and registers cleanly, then throws on a real render
  //    (`TypeError: o is not a function`) -- see `block-openapi/component.js`'s header comment.
  //    This alias pins resolution back to the self-contained webpack build.
  resolve: {
    alias: {
      'swagger-ui': path.resolve('node_modules/swagger-ui/dist/swagger-ui-bundle.js')
    }
  },
  output: {
    dir: 'compiled',
    format: 'es',
    // -> Rolldown's built-in Oxc minifier has no ECMA version target knob, so the output carries no
    //    stated language-level floor. Nothing here can restate one until it does.
    minify: true
  },
  plugins: [blocksManifest(), blockAssets(), cssAsString(), buildSummary()]
  // -> No plugin for CommonJS interop or Node resolution: both are built into Rolldown.
}
