# WP 3653 - recommended comments

Not applied; comments are recommendations only.

## `backend/helpers/appShell.ts`

Above `insertIntoAppShell`:

```ts
/**
 * Per-request insertion into the memoised shell, which is never mutated. Both insertion points are
 * found in the original template before either fragment is spliced, so a fragment containing
 * `</head>` or `</body>` cannot capture the other insertion. Fragments go in verbatim (sliced in,
 * not `String.replace`d, so `$&` is inert) and are the caller's to make safe. A fragment whose
 * closing tag is absent is dropped rather than failing the shell.
 */
```

## `backend/core/http/siteRouting.ts`

In the `registerAppShellFallback` doc comment, after the `lang`/`dir` paragraph, add: per-request
head/body fragments are inserted by `helpers/appShell.ts#insertIntoAppShell` after the memoised
lookup, so the memoised template stays request-independent.
