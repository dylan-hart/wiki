/*
  monaco-editor 0.56 declares `"./*.js": "./esm/vs/*.js"` (and `"./*"` the same) in its exports map,
  so a subpath specifier that already starts with `esm/vs/` gets that prefix appended a second time,
  landing on `esm/vs/esm/vs/...`, which doesn't exist -- see the `resolve.alias` entry for
  `editor.api.js` below, which hit the same thing. Every specifier here drops the `esm/vs/` prefix
  for that reason; each one still resolves to the same file on disk, just without the doubling.
*/
import EditorWorker from 'monaco-editor/editor/common/services/editorWebWorkerMain.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

/*
  This file was never imported by `main.js`, so none of this ever ran and `self.MonacoEnvironment`
  was never set -- every editor instance was silently falling all the way through monaco's own
  internal worker-loading fallbacks. That fallback works for the json/css/html/typescript workers
  (monaco's `workerManager.js` for each hands a `createWorker: () => new Worker(new URL('json.worker.js',
  import.meta.url), ...)` co-located call that Vite's built-in Worker-detection bundles automatically,
  no config needed), but the core `editorWorkerService` worker -- used for diffing, links, unicode
  highlights, and every plain-text/markdown model -- has no such fallback. Its `WebWorkerDescriptor`
  only offers `esmModuleLocationBundler: () => new URL('../../common/services/editorWebWorkerMain.js',
  import.meta.url)`, and because that `new URL(...)` isn't written directly inside a `new Worker(...)`
  call at the same call site, Vite doesn't recognize it as a worker reference at all -- it treats the
  tiny target file as a generic static asset and inlines it as a `data:` URL, unbundled, with its own
  relative imports left untouched. Those relative imports then fail to resolve against the `data:` URL
  as a base ("Invalid relative url or base scheme is not hierarchical"), which is exactly the reported
  error. Providing `MonacoEnvironment.getWorker` here is checked first for every worker monaco creates
  (`internal/common/workers.js`'s `getWorker()` and `standaloneWebWorkerService.js`'s `_createWorker()`
  both consult it before falling back to their own bundler URLs), so it fully replaces that broken path.
*/
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'json') {
      return new JsonWorker()
    }
    if (label === 'css' || label === 'scss' || label === 'less') {
      return new CssWorker()
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new HtmlWorker()
    }
    if (label === 'typescript' || label === 'javascript') {
      return new TsWorker()
    }
    return new EditorWorker()
  }
}
