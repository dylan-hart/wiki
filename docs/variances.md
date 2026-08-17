# Variances

Genuine, justified deviations from spec — not a changelog. An entry is removed once resolved rather
than left as historical prose.

## 2026-08-17 — `frontend/src/renderers/markdown.test.js` uses Vitest, not `node --test`

Task 479 (Feature 364, "Markdown/Monaco Editor Hardening") specified adding a Node-native
`node --test` harness for `frontend/`, on the stated premise that `frontend/package.json` had "zero
test tooling configured." That premise no longer holds: Feature 424 ("Test infrastructure") landed a
project-wide Vitest + `@vue/test-utils` harness for `frontend/` first — `npm test` already runs
`vitest run`, `vitest.config.js` and `test/setup.js` already exist, and eight other `*.test.js` files
already use it (see CLAUDE.md, "Testing (frontend)").

Adding a second, parallel test runner (`node --test`) for exactly one file would mean two ways to
discover and run frontend tests, two config files answering the same question, and a `node --test`
suite that cannot share `test/setup.js`'s `API_CLIENT`/`EVENT_BUS` stubs or the Tailwind/SCSS/`@`-alias
Vite pipeline the rest of the suite relies on — for a class (`MarkdownRenderer`) that turns out to
need Vite's own module resolution anyway (see below), which `node --test` cannot provide at all. So
`markdown.test.js` was written as an ordinary co-located Vitest file instead, matching every other
frontend test.

`MarkdownRenderer` is otherwise exactly what the task predicted: pure, DOM-free, and importable
directly (confirmed by `renderers/headless.js`, which runs the identical class server-side under
Puppeteer). The one twist is that it could not originally be imported under Vitest at all —
`markdown-it-mdc` still imports the `markdown-it/lib/token.mjs` subpath that markdown-it 15 removed,
which `vite.config.js` already aliases around for the real app build, but `vitest.config.js`
(deliberately a separate config, see its own header comment) had no reason to carry that alias until
this test needed it. Vitest also externalizes `node_modules` packages to Node's own resolver by
default, which bypasses Vite `resolve.alias` entirely, so the fix needed two parts, both now in
`vitest.config.js`: the same `markdown-it/lib/token.mjs` alias `vite.config.js` has, plus
`test.server.deps.inline: ['markdown-it-mdc']` to force that one package through Vite's resolver
(where the alias applies) instead of Node's.

Recording this so a future pass over task 479 does not re-propose `node --test` for this file.
