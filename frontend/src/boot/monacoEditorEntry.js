/*
  A trimmed stand-in for the `monaco-editor` package's own entry point (`esm/vs/index.js`, what
  `import ... from 'monaco-editor'` resolves to): `vite.config.js`'s `resolve.alias` redirects the
  bare specifier here for every real build/dev bundle, so call sites keep writing
  `import * as monaco from 'monaco-editor'` unchanged. The alias is exact-match only, so a DEEP
  specifier such as `boot/monaco.js`'s own worker imports still resolves into the real package.
  `vitest.config.js` deliberately carries no such alias, so `vi.mock('monaco-editor', ...)` keeps
  intercepting the bare specifier -- this file is only ever reached by a Vite build or the dev
  server.

  It exists because monaco's own entry point imports ALL FOUR advanced language "features" -- css,
  html, json and typescript -- unconditionally, and each one's `workerManager.js` carries a
  `new Worker(new URL(...))` call that Vite's worker plugin bundles into `assets/` purely from
  STATIC analysis, regardless of whether the constructor is ever called. That is what put the
  multi-megabyte ts and css worker chunks into the build although nothing in this codebase creates a
  Monaco model in those languages; trimming `boot/monaco.js`'s `getWorker` map alone could not
  remove them, because they were reachable through monaco's own code rather than ours.

  Generated from `monaco-editor@0.56.0`'s `esm/vs/index.js` rather than transcribed by hand, with
  four kinds of change:
    1. The `css` and `typescript` language FEATURE imports (and their re-exports) are dropped --
       the lines that carry the worker-bundling code above. Regenerate this file if a future editor
       surface genuinely needs TypeScript or CSS language services, rather than hand-editing it.
    2. Every remaining `./x` relative import becomes a deep `monaco-editor/x` specifier, dropping
       the `esm/vs/` prefix -- the package's `"./*.js": "./esm/vs/*.js"` exports-map entry would
       double that prefix otherwise.
    3. The two `.css` imports (codicon glyphs, which monaco's own UI chrome draws from) don't end in
       `.js`, so they would fall through to the exports map's generic `"./*": "./esm/vs/*.js"`
       fallback, which wrongly appends a literal `.js` AFTER the `.css` extension. They go in as a
       plain relative path into this workspace's own `node_modules` instead, which bypasses
       package-exports encapsulation entirely -- safe here specifically because every workspace in
       this repo is independently installed, so there is no hoisting to account for.
    4. `index.js`'s re-export of `../external/monaco-lsp-client/out/index.js` as `monaco.lsp` is
       dropped: that path is outside `esm/vs/`, so it cannot be reached through the public exports
       map at all, and nothing in this codebase reads `monaco.lsp`.
*/

import 'monaco-editor/languages/definitions/abap/register.js'
import 'monaco-editor/languages/definitions/apex/register.js'
import 'monaco-editor/languages/definitions/azcli/register.js'
import 'monaco-editor/languages/definitions/bat/register.js'
import 'monaco-editor/languages/definitions/bicep/register.js'
import 'monaco-editor/languages/definitions/cameligo/register.js'
import 'monaco-editor/languages/definitions/clojure/register.js'
import 'monaco-editor/languages/definitions/coffee/register.js'
import 'monaco-editor/languages/definitions/cpp/register.js'
import 'monaco-editor/languages/definitions/csharp/register.js'
import 'monaco-editor/languages/definitions/csp/register.js'
import 'monaco-editor/languages/definitions/css/register.js'
import 'monaco-editor/languages/definitions/cypher/register.js'
import 'monaco-editor/languages/definitions/dart/register.js'
import 'monaco-editor/languages/definitions/dockerfile/register.js'
import 'monaco-editor/languages/definitions/ecl/register.js'
import 'monaco-editor/languages/definitions/elixir/register.js'
import 'monaco-editor/languages/definitions/flow9/register.js'
import 'monaco-editor/languages/definitions/fsharp/register.js'
import 'monaco-editor/languages/definitions/freemarker2/register.js'
import 'monaco-editor/languages/definitions/go/register.js'
import 'monaco-editor/languages/definitions/graphql/register.js'
import 'monaco-editor/languages/definitions/handlebars/register.js'
import 'monaco-editor/languages/definitions/hcl/register.js'
import 'monaco-editor/languages/definitions/html/register.js'
import 'monaco-editor/languages/definitions/ini/register.js'
import 'monaco-editor/languages/definitions/java/register.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
import 'monaco-editor/languages/definitions/julia/register.js'
import 'monaco-editor/languages/definitions/kotlin/register.js'
import 'monaco-editor/languages/definitions/less/register.js'
import 'monaco-editor/languages/definitions/lexon/register.js'
import 'monaco-editor/languages/definitions/lua/register.js'
import 'monaco-editor/languages/definitions/liquid/register.js'
import 'monaco-editor/languages/definitions/m3/register.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/definitions/mdx/register.js'
import 'monaco-editor/languages/definitions/mips/register.js'
import 'monaco-editor/languages/definitions/msdax/register.js'
import 'monaco-editor/languages/definitions/mysql/register.js'
import 'monaco-editor/languages/definitions/objective-c/register.js'
import 'monaco-editor/languages/definitions/pascal/register.js'
import 'monaco-editor/languages/definitions/pascaligo/register.js'
import 'monaco-editor/languages/definitions/perl/register.js'
import 'monaco-editor/languages/definitions/pgsql/register.js'
import 'monaco-editor/languages/definitions/php/register.js'
import 'monaco-editor/languages/definitions/pla/register.js'
import 'monaco-editor/languages/definitions/postiats/register.js'
import 'monaco-editor/languages/definitions/powerquery/register.js'
import 'monaco-editor/languages/definitions/powershell/register.js'
import 'monaco-editor/languages/definitions/protobuf/register.js'
import 'monaco-editor/languages/definitions/pug/register.js'
import 'monaco-editor/languages/definitions/python/register.js'
import 'monaco-editor/languages/definitions/qsharp/register.js'
import 'monaco-editor/languages/definitions/r/register.js'
import 'monaco-editor/languages/definitions/razor/register.js'
import 'monaco-editor/languages/definitions/redis/register.js'
import 'monaco-editor/languages/definitions/redshift/register.js'
import 'monaco-editor/languages/definitions/restructuredtext/register.js'
import 'monaco-editor/languages/definitions/ruby/register.js'
import 'monaco-editor/languages/definitions/rust/register.js'
import 'monaco-editor/languages/definitions/sb/register.js'
import 'monaco-editor/languages/definitions/scala/register.js'
import 'monaco-editor/languages/definitions/scheme/register.js'
import 'monaco-editor/languages/definitions/scss/register.js'
import 'monaco-editor/languages/definitions/shell/register.js'
import 'monaco-editor/languages/definitions/solidity/register.js'
import 'monaco-editor/languages/definitions/sophia/register.js'
import 'monaco-editor/languages/definitions/sparql/register.js'
import 'monaco-editor/languages/definitions/sql/register.js'
import 'monaco-editor/languages/definitions/st/register.js'
import 'monaco-editor/languages/definitions/swift/register.js'
import 'monaco-editor/languages/definitions/systemverilog/register.js'
import 'monaco-editor/languages/definitions/tcl/register.js'
import 'monaco-editor/languages/definitions/twig/register.js'
import 'monaco-editor/languages/definitions/typescript/register.js'
import 'monaco-editor/languages/definitions/typespec/register.js'
import 'monaco-editor/languages/definitions/vb/register.js'
import 'monaco-editor/languages/definitions/wgsl/register.js'
import 'monaco-editor/languages/definitions/xml/register.js'
import 'monaco-editor/languages/definitions/yaml/register.js'
import * as __src_languages_features_html_register_ts from 'monaco-editor/languages/features/html/register.js'
export { __src_languages_features_html_register_ts as html }
import * as __src_languages_features_json_register_ts from 'monaco-editor/languages/features/json/register.js'
export { __src_languages_features_json_register_ts as json }
import 'monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/transpose.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js'
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js'
import 'monaco-editor/editor/contrib/codelens/browser/codelensController.js'
import '../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css'
import 'monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution.js'
import 'monaco-editor/editor/contrib/comment/browser/comment.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js'
import 'monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js'
import 'monaco-editor/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js'
import 'monaco-editor/editor/contrib/dnd/browser/dnd.js'
import 'monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js'
import 'monaco-editor/features/find/register.js'
import 'monaco-editor/editor/contrib/floatingMenu/browser/floatingMenu.contribution.js'
import 'monaco-editor/editor/contrib/folding/browser/folding.js'
import 'monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js'
import 'monaco-editor/editor/contrib/format/browser/formatActions.js'
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js'
import 'monaco-editor/editor/contrib/gpu/browser/gpuActions.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js'
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js'
import 'monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js'
import 'monaco-editor/editor/contrib/inlineProgress/browser/inlineProgress.js'
import 'monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js'
import 'monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js'
import 'monaco-editor/editor/standalone/browser/inspectTokens/inspectTokens.js'
import 'monaco-editor/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js'
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js'
import 'monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing.js'
import 'monaco-editor/editor/contrib/links/browser/links.js'
import 'monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper.js'
import 'monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution.js'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js'
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js'
import 'monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js'
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js'
import 'monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js'
import 'monaco-editor/editor/contrib/rename/browser/rename.js'
import 'monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders.js'
import 'monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js'
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js'
import 'monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestInlineCompletions.js'
import 'monaco-editor/editor/standalone/browser/toggleHighContrast/toggleHighContrast.js'
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js'
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js'
import 'monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js'
import 'monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js'
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js'
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js'
import 'monaco-editor/editor/browser/coreCommands.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js'
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js'
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/editor/common/standaloneStrings.js'
import '../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css'
export {
  CancellationTokenSource,
  Emitter,
  KeyCode,
  KeyMod,
  MarkerSeverity,
  MarkerTag,
  Position,
  Range,
  Selection,
  SelectionDirection,
  Token,
  Uri,
  editor,
  languages
} from 'monaco-editor/editor/editor.api.js'
