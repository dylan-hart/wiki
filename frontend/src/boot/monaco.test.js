import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
  Each mock stands in for one of the `?worker` modules `boot/monaco.js` imports, tagged with its own
  label so a test can tell which one `getWorker()` actually reached for.
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

  // -> An import alone ships the chunk, whether or not its constructor ever runs
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

  it('falls back to the base editor worker for css, scss and less', async () => {
    await import('./monaco.js')
    for (const label of ['css', 'scss', 'less']) {
      expect(self.MonacoEnvironment.getWorker(null, label).kind).toBe('editor')
    }
  })

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
