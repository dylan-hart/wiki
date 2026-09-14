# Decision Record: Why Multi-Statement Inline Vue Handlers Aren't Worth Fixing at the Tooling Level

**Status:** Decided — write a named handler instead; do not attempt a compiler or formatter fix

## The problem

`@click="doOne(); doTwo()"` builds today and becomes a build error the moment the file is formatted,
because `semi: false` (oxfmt) and Vue disagree about the same character. Vue's `transformOn` decides
whether an inline handler is a statement block or an expression from `exp.content.includes(';')` —
with the semicolon present it emits `$event => { … }`; without it, `$event => ( … )`. oxfmt breaks
the handler across lines and drops the semicolon, so Vue parenthesises what is now two statements and
the template fails to compile (`Error parsing JavaScript expression: Unexpected token`).

## Why neither side gets reconfigured

- **The `includes(';')` check has no compiler option behind it.** There's nothing to flip.
- **The parse error is raised by the built-in `transformExpression`**, which `baseCompile` runs
  _before_ any `nodeTransforms` a consumer could add — there's no hook point early enough to intercept
  it.
- **Volar runs the same compiler**, so even a build-time workaround would still leave the editor
  showing the error live.
- **On the formatter side, `embeddedLanguageFormatting: "off"` does leave attribute expressions
  alone — but it also stops formatting every `<script>` and `<style>` block in every SFC.** The fix
  for one narrow case would cost formatting for the whole file type.
- **This is not an oxfmt quirk.** Prettier with `--no-semi` produces identical output — the
  incompatibility is between Vue's compiler and any no-semicolon formatting style, not specific to
  this toolchain.

## The resolution

Write a named handler instead of an inline multi-statement one — `@click="closeAndRefresh"`, as
`EditorMarkdown.vue` and `PageRelationDialog.vue` do. For a genuine one-off where the inline form
reads better, `<!-- prettier-ignore -->` on the preceding line works (oxfmt honors Prettier's marker;
there is no `oxfmt-ignore`).
