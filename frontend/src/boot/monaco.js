/*
  monaco-editor 0.56 declares `"./*.js": "./esm/vs/*.js"` (and `"./*"` the same) in its exports map,
  so a subpath specifier that already starts with `esm/vs/` gets that prefix appended a second time,
  landing on `esm/vs/esm/vs/...`, which doesn't exist. Every specifier here drops the `esm/vs/`
  prefix for that reason; each still resolves to the same file on disk, just without the doubling.
*/
import EditorWorker from 'monaco-editor/editor/common/services/editorWebWorkerMain.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'

/*
  No `css.worker`/`ts.worker` import: no editor surface in this codebase creates a Monaco model in a
  CSS- or TypeScript-family language -- every one uses `markdown`, `html`, `json` or `plaintext` --
  and Vite bundles a `?worker` import into the build whether or not its constructor is ever called,
  so both were shipping multi-megabyte chunks nothing in the app could trigger. Their labels fall
  through to the default `EditorWorker` branch below; a surface that genuinely needs those language
  services adds the import and a branch back deliberately, rather than leaning on the fallback.
*/

/*
  Monaco's own worker-loading fallback works for the json/html workers (each `workerManager.js`
  hands Vite a co-located `new Worker(new URL('...', import.meta.url))` call it detects
  automatically), but the core `editorWorkerService` worker -- diffing, links, unicode highlights,
  and every plain-text/markdown model -- has none. Its `WebWorkerDescriptor` only offers a bare
  `new URL(...)`, which Vite does not recognise as a worker reference: it inlines the target as an
  unbundled `data:` URL, against which the file's own relative imports then fail to resolve
  ("Invalid relative url or base scheme is not hierarchical"). `MonacoEnvironment.getWorker` is
  consulted before any of that, for every worker monaco creates, so defining it here replaces the
  broken path entirely.
*/
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'json') {
      return new JsonWorker()
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new HtmlWorker()
    }
    return new EditorWorker()
  }
}
