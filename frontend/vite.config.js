import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
// -> A named import: js-yaml 5 ships ESM with no default export, so `import yaml from` throws
import { load as loadYaml } from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vueDevTools from 'vite-plugin-vue-devtools'
import { temporalPolyfillChunkPlugin } from './src/build/temporalPolyfillChunk.js'

const TWEMOJI_ROUTE = '/_assets/svg/twemoji'

/**
 * The parser and the artwork are two dependencies of the same upstream release (see below), so an
 * upgrade can drift them apart with nothing to say so -- what that looks like is a page with a
 * broken image in it, or an emoji left to whatever font the reader has. The renderer hands the
 * emoji plugin's tokens to twemoji and nothing else -- a raw emoji character typed into a page
 * stays a character -- so `markdown-it-emoji`'s shortcode map IS the vocabulary, and running the
 * parser over it yields exactly the set of files a page can ask for.
 *
 * `@twemoji/api` is held a patch behind for this reason: 17.0.3's parser stopped matching ten
 * emoji at all, leaving them as text.
 */
async function verifyTwemojiCoverage(svgDir) {
  const [{ default: twemoji }, { default: shortcodes }] = await Promise.all([
    import('@twemoji/api'),
    import('markdown-it-emoji/lib/data/full.mjs')
  ])
  const unmatched = []
  const missing = []
  for (const [shortcode, emoji] of Object.entries(shortcodes)) {
    const icons = []
    twemoji.parse(emoji, {
      callback(icon) {
        if (icon) {
          icons.push(icon)
        }
        // -> Nothing is being rendered here; the callback is only how the names are read back out
        return false
      }
    })
    if (icons.length === 0) {
      unmatched.push(`:${shortcode}:`)
      continue
    }
    for (const icon of icons) {
      if (!fs.existsSync(path.join(svgDir, `${icon}.svg`))) {
        missing.push(`:${shortcode}: (${icon}.svg)`)
      }
    }
  }
  const complaints = [
    unmatched.length > 0 &&
      `${unmatched.length} the parser no longer matches: ${unmatched.join(' ')}`,
    missing.length > 0 && `${missing.length} with no SVG in ${svgDir}: ${missing.join(' ')}`
  ].filter(Boolean)
  if (complaints.length > 0) {
    throw new Error(
      `twemoji: ${complaints.join('; ')}. Check that '@twemoji/api' and the 'twemoji-assets' tarball in package.json still name the same upstream release.`
    )
  }
}

/**
 * `/_assets/svg/twemoji/<codepoints>.svg` is the `src` `src/renderers/markdown.js` writes for every
 * emoji. The set is ~4000 files and 18 MB, none of it a build input -- nothing in the source names
 * an individual icon, so Vite has no way to discover them. They are copied into the build output
 * and read from `node_modules` on the fly in dev rather than committed under `public/`, which would
 * put 4000 derived files in git.
 *
 * `@twemoji/api` is the parser alone; the artwork has never been published to npm, so
 * `package.json` takes it from the upstream repository as a tarball dependency (`twemoji-assets`)
 * pinned by commit SHA rather than a tag, since a tag can move. npm records its integrity hash in
 * the lockfile, so the build itself needs no network.
 *
 * Before touching that pin:
 *
 * - It installs a second copy of `@twemoji/api` -- the tarball IS that package, aliased, for the
 *   artwork alone. Tolerated because there is no other source for the SVGs.
 * - No update tool understands a `codeload.github.com` tarball URL, so bumping is a manual edit:
 *   resolve the new tag's commit SHA (`gh api repos/jdecked/twemoji/git/ref/tags/<tag>`,
 *   dereferencing an annotated tag's `object` if its `type` isn't already `commit`), rewrite the
 *   URL, then `npm install`. It moves in lockstep with `@twemoji/api`, gated by
 *   `verifyTwemojiCoverage` above.
 * - Regenerating the lockfile changes the integrity hash even when the commit is unchanged:
 *   `codeload.github.com` embeds the literal ref string from the request URL as the tarball's
 *   top-level directory name, so a tag-ref request and a SHA-ref request for the same commit hash
 *   differently. Diff the resolved SHA rather than trusting an unchanged hash. See
 *   `docs/decisions/twemoji-assets-sha-pin-integrity-hash-change.md`.
 */
function twemojiAssets() {
  const svgDir = path.join(
    path.dirname(createRequire(import.meta.url).resolve('twemoji-assets/package.json')),
    'assets/svg'
  )
  let outDir = null

  return {
    name: 'wiki-twemoji-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      // -> connect strips the prefix, so `req.url` is just the file name here
      server.middlewares.use(TWEMOJI_ROUTE, (req, res, next) => {
        // -> Both a traversal guard and a cheap 404 for anything that is not one of these files
        const name = path.basename(req.url.split('?')[0])
        if (!/^[0-9a-f]+(-[0-9a-f]+)*\.svg$/.test(name)) {
          next()
          return
        }
        fs.promises.readFile(path.join(svgDir, name)).then((svg) => {
          res.setHeader('Content-Type', 'image/svg+xml')
          res.end(svg)
        }, next)
      })
    },
    // -> Not `emitFile`: 4000 assets through rollup for files that need no processing at all
    async writeBundle() {
      await verifyTwemojiCoverage(svgDir)
      await fs.promises.cp(svgDir, path.join(outDir, TWEMOJI_ROUTE.slice(1)), { recursive: true })
    }
  }
}

export default defineConfig(({ mode }) => {
  const userConfig =
    mode === 'development'
      ? {
          dev: { port: 3001, hmrClientPort: 3001 },
          ...loadYaml(
            fs.readFileSync(fileURLToPath(new URL('../config.yml', import.meta.url)), 'utf8')
          )
        }
      : {}

  return {
    build: {
      assetsDir: '_assets',
      // -> Left at (near) Rollup's own 500 kB default rather than raised -- a warning here is the
      //    signal that a change grew a chunk, not something to silence. The chunks already over it
      //    are accounted for in docs/decisions/frontend-chunk-size-warnings.md.
      chunkSizeWarningLimit: 500,
      dynamicImportVarsOptions: {
        include: ['!/_blocks/**']
      },
      outDir: '../assets',
      rollupOptions: {
        // -> A second entry alongside the app: the markdown pipeline on its own, so the backend can
        //    drive it in a headless browser to re-render a page server-side
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          renderer: fileURLToPath(new URL('./src/renderers/headless.js', import.meta.url))
        },
        output: {
          // -> The renderer keeps a fixed name because it is referenced from a static page served by
          //    the backend, which has no way to look up a hashed one
          entryFileNames: (chunk) =>
            chunk.name === 'renderer' ? '_assets/renderer.js' : '_assets/[name]-[hash].js'
        }
      },
      target: 'es2022'
    },
    // -> Monaco's editor worker does a relative `import()` for its findSectionHeaders feature; Vite's
    //    default production worker format (IIFE) is bundled and loaded from a `blob:` URL, which can't
    //    resolve a relative specifier (`blob:` isn't a hierarchical scheme). ES module workers can.
    worker: {
      format: 'es'
    },
    plugins: [
      vue({
        template: {
          /*
            `/_assets/...` paths are served by the backend at runtime, with nothing at that path on
            disk; Vue's default would turn each one into an import and fail the build.
          */
          transformAssetUrls: { includeAbsolute: false },
          // -> `iconify-icon` is a custom element registered by its package, not a Vue component
          compilerOptions: {
            isCustomElement: (tag) => tag === 'iconify-icon'
          }
        }
      }),
      tailwindcss(),
      twemojiAssets(),
      temporalPolyfillChunkPlugin(),
      vueDevTools()
    ],
    resolve: {
      alias: [
        { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
        /*
          A RegExp `find`, not a plain string: a string alias key resolves as a PREFIX match, so a
          plain `'monaco-editor'` key also rewrites deep specifiers like
          `monaco-editor/language/json/json.worker?worker` into a broken path. Anchored, it
          redirects nothing but the bare specifier every editor surface imports.
          The alias itself exists because the real package's entry point pulls in language services
          this app never uses (see `src/boot/monacoEditorEntry.js`). Deliberately absent from
          `vitest.config.js`: it matters only for a real build or the dev server, and each test
          file's own `vi.mock('monaco-editor', ...)` intercepts the bare specifier regardless.
        */
        {
          find: /^monaco-editor$/,
          replacement: fileURLToPath(new URL('./src/boot/monacoEditorEntry.js', import.meta.url))
        }
      ]
    },
    server: {
      open: false,
      host: '0.0.0.0',
      allowedHosts: true,
      port: userConfig.dev?.port,
      proxy: [
        '_api',
        '_blocks',
        '_collab',
        '_files',
        '_icons',
        '_site',
        '_terminal',
        '_thumb',
        '_user'
      ].reduce((result, key) => {
        result[`/${key}`] = {
          target: {
            host: '127.0.0.1',
            port: userConfig.port
          },
          // -> `_collab` and `_terminal` are websockets; the rest are unaffected by this being on
          ws: true
        }
        return result
      }, {}),
      hmr: {
        clientPort: userConfig.dev?.hmrClientPort
      }
    }
  }
})
