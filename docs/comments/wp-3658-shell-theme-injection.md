# WP 3658 - recommended comments

Not applied; comments are recommendations only.

## `backend/helpers/shellTheme.ts`

Above `INJECT_CSS_ELEMENT_ID`:

```ts
// Same id as `frontend/src/helpers/injectCss.js`, so the booted SPA replaces this element rather than stacking a second.
```

Above `themeShellFragments`:

```ts
/**
 * `injectHead` and `injectBody` go in verbatim, behind the same `manage:sites` trust boundary as the
 * client-side application. `injectCSS` sits inside a `<style>`, so a literal `</style` is rewritten
 * to `<\/style` (an escaped `/` in CSS) to keep it from ending the element.
 */
```

## `backend/core/http/siteRouting.ts`

In the `registerAppShellFallback` doc comment: the site's raw theme injection (`injectHead`,
`injectCSS`, `injectBody`) is inserted per request from the cached `CARDINAL.sites[siteId].config`, so
a raw fetch carries it without JS. Behaviour under `security.enforceCsp` is unchanged: the shipped
`script-src 'self'` still refuses an injected inline script.
