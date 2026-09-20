/**
 * Replays a route file's registration against a recording stub instead of a real Fastify instance.
 *
 * Booting the genuine app to inspect route options needs the AJV customization `index.ts` installs
 * purely to build validators, none of which a structural scan cares about — and `index.ts` itself
 * cannot be imported from a test at all, since it runs the full boot sequence (database included) via
 * top-level await. Recording the exact `(method, path, options)` triple each `app.get/post/put/patch/
 * delete` call makes is what a real instance would also see; only the working validators and
 * serializers built around it are skipped, which is exactly the part a scan of `schema.tags` /
 * `schema.response` does not need.
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
    // -> Present only so a route file's registration body runs to completion; a structural scan
    //    reads none of them.
    addContentTypeParser: () => {},
    addHook: () => {},
    addSchema: () => {},
    /**
     * A route resource that is a DIRECTORY registers its sub-plugins here, so this has to REPLAY
     * them — a no-op `register` would make every route in a split resource invisible to a scan
     * while the scan itself still passed.
     *
     * A `fastify-plugin`-wrapped third-party plugin (`@fastify/multipart`) is skipped instead:
     * `skip-override` is the marker that says so, those plugins add decorators and body parsers
     * rather than routes a scan reads, and running one against this stub would only throw on the
     * Fastify internals it expects to find.
     *
     * No `prefix` handling on purpose: every sub-plugin in this repo declares whole paths and is
     * registered unprefixed, so a recorded path is the mounted one. A prefixed sub-plugin would need
     * this to prepend it before that stayed true.
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
  /** File or directory names, relative to `apiDir`, to leave out of the scan. */
  exclude?: string[]
}

/**
 * Recursive, because a route resource is allowed to be a DIRECTORY rather than a single file: one
 * holding an `index.ts` plus its siblings registers through that `index.ts`, so that is the single
 * entry yielded for it — one entry per resource either way, which is what keeps a scan's "one plugin
 * per route file" replay honest as the larger route files get split up.
 *
 * `schemas/` is skipped (shared JSON Schemas, not routes), as are `*.test.ts` and the top-level
 * `index.ts` (it only re-registers the others).
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
 * The one `CARDINAL` member a route file may touch while REGISTERING rather than inside a handler
 * closure: `assets.ts`'s upload content-type parser reads `CARDINAL.config.security?.uploadMaxFileSize`
 * to size its body limit. Nothing here executes a handler, so no other member is ever reached.
 *
 * Deliberately `??=`, not an install/restore pair: a scan runs at module scope, before any
 * `before()`, and must not clobber a `CARDINAL` a co-resident suite already installed.
 */
export function stubWikiForRegistration(): void {
  ;(globalThis as any).CARDINAL ??= { config: {} }
}
