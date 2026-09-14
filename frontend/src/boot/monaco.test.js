import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
  `boot/monaco.js` statically imports each worker module via Vite's `?worker` suffix -- which is
  exactly why an unused import still ends up emitted into `assets/`: the worker chunk is part of the
  static module graph regardless of whether its constructor is ever called at runtime (OpenProject
  #3171). Each mock below stands in for one such `?worker` module, tagged with its own label so a
  test can tell which one `getWorker()` actually reached for.
*/
vi.mock('monaco-editor/editor/common/services/editorWebWorkerMain.js?worker', () => ({
  default: class EditorWorker {
    kind = 'editor'
  }
}))
vi.mock('monaco-editor/language/json/json.worker?worker', () => ({
  default: class JsonWorker {
    kind = 'json'
  }
}))
vi.mock('monaco-editor/language/html/html.worker?worker', () => ({
  default: class HtmlWorker {
    kind = 'html'
  }
}))

const SRC_DIR = dirname(fileURLToPath(import.meta.url))
const MONACO_BOOT_SOURCE = readFileSync(join(SRC_DIR, 'monaco.js'), 'utf8')

describe('boot/monaco', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  /**
   * OpenProject #3171: no editor surface in this codebase ever creates a model with
   * `language: 'typescript'`, `'javascript'`, `'css'`, `'scss'`, or `'less'` (the full inventory is
   * in the work package's implementation-plan comment) -- so `ts.worker` (6.9 MB) and `css.worker`
   * (1.05 MB) must not even be imported any more, let alone shipped as separate build chunks.
   */
  it('no longer imports the ts.worker or css.worker modules', () => {
    expect(MONACO_BOOT_SOURCE).not.toMatch(/language\/typescript\/ts\.worker/)
    expect(MONACO_BOOT_SOURCE).not.toMatch(/language\/css\/css\.worker/)
  })

  it('routes json to the json worker', async () => {
    await import('./monaco.js')
    const worker = self.MonacoEnvironment.getWorker(null, 'json')
    expect(worker.kind).toBe('json')
  })

  it('routes html, handlebars and razor to the html worker', async () => {
    await import('./monaco.js')
    for (const label of ['html', 'handlebars', 'razor']) {
      expect(self.MonacoEnvironment.getWorker(null, label).kind).toBe('html')
    }
  })

  /** The WP's own instruction: a dropped worker's labels fall back to the base editor worker. */
  it('falls back to the base editor worker for css, scss and less', async () => {
    await import('./monaco.js')
    for (const label of ['css', 'scss', 'less']) {
      expect(self.MonacoEnvironment.getWorker(null, label).kind).toBe('editor')
    }
  })

  /** Same fallback for the other dropped worker's labels. */
  it('falls back to the base editor worker for typescript and javascript', async () => {
    await import('./monaco.js')
    for (const label of ['typescript', 'javascript']) {
      expect(self.MonacoEnvironment.getWorker(null, label).kind).toBe('editor')
    }
  })

  it('falls back to the base editor worker for any other label', async () => {
    await import('./monaco.js')
    expect(self.MonacoEnvironment.getWorker(null, 'markdown').kind).toBe('editor')
    expect(self.MonacoEnvironment.getWorker(null, 'plaintext').kind).toBe('editor')
  })
})
