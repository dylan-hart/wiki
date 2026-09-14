/**
 * SPIKE / PROOF-OF-CONCEPT — not wired into `npm run build`.
 *
 * OpenProject #3175: evaluate replacing `rollup.config.mjs` (rollup +
 * `@rollup/plugin-commonjs`/`-node-resolve`/`-terser` + `rollup-plugin-summary`) with Rolldown, the
 * Rust bundler already installed transitively (via `vitest` -> `vite` 8 -> `rolldown`).
 *
 * Run it by hand to compare against the real build:
 *
 *   npx rolldown -c rolldown.config.mjs
 *   diff -rq compiled compiled-rolldown
 *
 * This file intentionally duplicates rather than imports the three custom Rollup plugins from
 * `rollup.config.mjs` (`blocksManifest`, `blockAssets`, `cssAsString`) -- `rollup.config.mjs` is
 * shared with WP #3174 this round (replacing `rollup-plugin-summary`), and the coordination note for
 * this round says #3175 must stay a PoC that does not touch the real build config. It DOES import
 * the pure `literalToValue` helper, which is already exported read-only for
 * `scripts/check-locale-keys.mjs` and isn't touched by #3174.
 *
 * Findings are written up in the WP #3175 go/no-go comment and in
 * `docs/decisions/2026-09-14-blocks-bundler-rolldown-spike.md`.
 */
import fs, { globSync } from 'node:fs'
import path from 'node:path'

import { literalToValue } from './rollup.config.mjs'

const IGNORED_DIR_PREFIXES = ['dist/', 'node_modules/']

function isIgnoredPath(matchedPath) {
  const posixPath = toPosix(matchedPath)
  return IGNORED_DIR_PREFIXES.some((prefix) => posixPath.startsWith(prefix))
}

function toPosix(filePath) {
  return filePath.replaceAll('\\', '/')
}

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

// -> Verbatim copy of `rollup.config.mjs`'s `cssAsString()` -- see that file for the full doc
//    comment. Kept here unchanged to prove the hooks it uses (`transform`, `this.warn`,
//    `this.addWatchFile`) behave identically under Rolldown's Rollup-compatible plugin API.
function cssAsString() {
  return {
    name: 'css-as-string',
    transform(code, id) {
      if (!id.endsWith('.css')) {
        return null
      }
      const baseDir = path.dirname(id)
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

// -> Verbatim copy of `rollup.config.mjs`'s `blocksManifest()`, output renamed so a diff against
//    the real `compiled/blocks.manifest.json` is trivial (`diff compiled/blocks.manifest.json
//    compiled-rolldown/blocks.manifest.json`). Exercises `this.parse` (AST parsing), `buildStart`,
//    `transform`, `generateBundle`, `this.error` and `this.warn`.
function blocksManifest() {
  const definitions = new Map()
  let expectedBlockCount = 0
  return {
    name: 'blocks-manifest',
    buildStart() {
      definitions.clear()
      expectedBlockCount = globSync('block-*/component.js', { exclude: isIgnoredPath }).length
    },
    transform(code, id) {
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
      if (definitions.size === 0 && expectedBlockCount > 0) {
        this.error(
          `Found ${expectedBlockCount} block-*/component.js file(s) on disk, but collected zero definitions from them -- blocks.manifest.json would be empty.`
        )
      }
      this.emitFile({
        type: 'asset',
        fileName: 'blocks.manifest.json',
        source: JSON.stringify([...definitions.values()], null, 2) + '\n'
      })
    }
  }
}

// -> Verbatim copy of `rollup.config.mjs`'s `blockAssets()`. Exercises `buildStart`,
//    `this.addWatchFile`, `this.error` and `emitFile` with binary `source` buffers.
function blockAssets() {
  return {
    name: 'block-assets',
    buildStart() {
      for (const listPath of globSync('block-*/assets.json', { exclude: isIgnoredPath })) {
        const blockDir = toPosix(listPath).split('/')[0]
        this.addWatchFile(listPath)
        const list = JSON.parse(fs.readFileSync(listPath, 'utf8'))
        for (const [source, destination] of Object.entries(list)) {
          const from = source.startsWith('.')
            ? path.resolve(blockDir, source)
            : path.resolve('node_modules', source)
          if (!fs.existsSync(from)) {
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

export default {
  input: Object.fromEntries([
    ...globSync('block-*/component.js', { exclude: isIgnoredPath }).map((file) => {
      const fileParts = toPosix(file).split('/')
      return [fileParts[0], file]
    }),
    ...globSync('block-*/worker.js', { exclude: isIgnoredPath }).map((file) => {
      const fileParts = toPosix(file).split('/')
      return [`${fileParts[0]}.worker`, file]
    })
  ]),
  // -> `platform: 'browser'` is stated rather than left to be inferred, matching the original
  //    rollup config's rationale for stating `exportConditions: ['production']` explicitly: it is
  //    ALSO how the `development` export condition (lit-html's `browser: { development: ...,
  //    default: ... }`) is kept out of the resolved condition set, since Rolldown's `browser`
  //    platform default condition list (`["import", "browser", "default"]`) never includes
  //    `development` in the first place -- there is no separate `production` condition to opt into
  //    the way `@rollup/plugin-node-resolve` exposed one; the equivalent is simply the absence of
  //    `development`. `format: 'es'` already implies `platform: 'browser'` by default, so this is
  //    belt-and-braces, matching how the rollup config over-states `production` today.
  platform: 'browser',
  // -> Rolldown's own CSS-bundling pipeline was removed as of 1.x (rolldown/rolldown#4271) and now
  //    hard-errors ("Bundling CSS is no longer supported") on any `.css`-extension module BEFORE a
  //    plugin's `transform` hook gets a chance to rewrite it -- unlike Rollup, which has no opinion
  //    about `.css` at all and defers entirely to `cssAsString()`'s `transform`. Declaring `.css` as
  //    module type `js` here is what makes Rolldown skip its own CSS handling and hand the raw file
  //    contents to `transform` as a plain (pre-parse) string, the same shape `cssAsString()` already
  //    expects. See the go/no-go writeup for why this survived the diff but is still worth flagging.
  moduleTypes: {
    '.css': 'js'
  },
  output: {
    // -> Deliberately NOT `compiled` -- this is a throwaway comparison directory, diffed against
    //    the real `compiled/` output produced by `npm run build` (rollup) and never served or
    //    committed. See the header comment.
    dir: 'compiled-rolldown',
    format: 'es',
    // -> Rolldown's built-in Oxc minifier, the built-in replacement for `@rollup/plugin-terser`.
    //    The old config pinned `ecma: 2019` for Terser; Rolldown's `MinifyOptions` has no ECMA
    //    version knob to match (see the go/no-go writeup for what that means for older-browser
    //    output).
    minify: true
  },
  plugins: [blocksManifest(), blockAssets(), cssAsString()]
  // -> No plugin for CommonJS interop or Node resolution: Rolldown's docs state both are built in,
  //    which is exactly the claim under test here (mermaid -> dayjs is the UMD/CJS case in this
  //    repo; see the go/no-go writeup for whether the built-in interop produced a working bundle).
}
