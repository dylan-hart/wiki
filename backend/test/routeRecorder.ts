/**
 * `index.ts` cannot be imported from a test at all — it runs the full boot sequence, database
 * included, via top-level await — and the AJV customization it installs exists purely to build
 * validators a structural scan never reads. The recorded `(method, path, options)` triple is what a
 * real instance would see too; only the working validators and serializers built around it are
 * missing.
 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export interface RecordedRoute {
  method: HttpMethod
  path: string
  options: any
}

export function createRecordingApp(): { app: any; routes: RecordedRoute[] } {
  const routes: RecordedRoute[] = []
  const app: any = {
    // -> Present only so a registration body runs to completion; a scan reads none of them.
    addContentTypeParser: () => {},
    addHook: () => {},
    addSchema: () => {},
    /**
     * Sub-plugins are REPLAYED: a no-op `register` would make every route in a directory-shaped
     * route resource invisible to a scan while the scan itself still passed.
     *
     * A `fastify-plugin`-wrapped third-party plugin (`skip-override` is the marker) is skipped
     * instead — it adds decorators and body parsers rather than routes a scan reads, and running one
     * against this stub would only throw on the Fastify internals it expects to find.
     *
     * No `prefix` handling on purpose: every sub-plugin here declares whole paths and is registered
     * unprefixed, so a recorded path is the mounted one. A prefixed one would need this to prepend
     * it before that stayed true.
     */
    register: async (plugin: any, opts?: any) => {
      const resolved = await plugin
      const fn = typeof resolved === 'function' ? resolved : resolved?.default
      if (typeof fn === 'function' && !fn[Symbol.for('skip-override')]) {
        await fn(app, opts ?? {})
      }
      return app
    }
  }
  for (const method of HTTP_METHODS) {
    app[method] = (routePath: string, options?: any) => {
      routes.push({ method, path: routePath, options })
      return app
    }
  }
  return { app, routes }
}

export interface ListApiRouteFilesOptions {
  /** File or directory names, or paths relative to `apiDir`. */
  exclude?: string[]
}

/**
 * Recursive because a route resource may be a DIRECTORY rather than a single file: one holding an
 * `index.ts` registers through it, so that is the single entry yielded — one entry per resource
 * either way, which keeps a scan's "one plugin per route file" replay honest as the larger route
 * files get split up.
 *
 * `schemas/` holds shared JSON Schemas rather than routes, and the top-level `index.ts` only
 * re-registers the others.
 */
export function listApiRouteFiles(apiDir: string, opts: ListApiRouteFilesOptions = {}): string[] {
  const exclude = new Set(['index.ts', 'schemas', ...(opts.exclude ?? [])])
  const out: string[] = []

  const walk = (dir: string, relative: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const rel = relative ? `${relative}/${entry}` : entry
      if (exclude.has(rel) || exclude.has(entry)) {
        continue
      }
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        const indexPath = path.join(full, 'index.ts')
        if (statSync(indexPath, { throwIfNoEntry: false })?.isFile()) {
          out.push(`${rel}/index.ts`)
        } else {
          walk(full, rel)
        }
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
        out.push(rel)
      }
    }
  }

  walk(apiDir, '')
  return out.sort()
}

export async function recordRoutesFrom(apiDir: string, file: string): Promise<RecordedRoute[]> {
  const { app, routes } = createRecordingApp()
  const mod = await import(path.join(apiDir, file))
  await mod.default(app)
  return routes
}

export function referencesApiError(entry: any): boolean {
  if (!entry) {
    return false
  }
  if (entry.$ref === 'ApiError#') {
    return true
  }
  return [...(entry.allOf ?? []), ...(entry.oneOf ?? [])].some(referencesApiError)
}

/**
 * `config` is the one `CARDINAL` member a route file touches while REGISTERING rather than inside a
 * handler closure (`assets.ts`'s upload content-type parser sizes its body limit from it); nothing
 * here executes a handler, so no other member is ever reached.
 *
 * Deliberately `??=`, not an install/restore pair: a scan runs at module scope, before any
 * `before()`, and must not clobber a `CARDINAL` a co-resident suite already installed.
 */
export function stubWikiForRegistration(): void {
  ;(globalThis as any).CARDINAL ??= { config: {} }
}
