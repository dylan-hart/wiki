# Contributing to Cardinal.js

Background and incident history behind some of the rules in `CLAUDE.md` and its nested files.
This file is for a human contributor who wants the full story; the actionable rule itself always
lives in the relevant `CLAUDE.md`, not here — this file adds no new *rules*, only the reasoning
behind existing ones.

## Why oxlint/oxfmt version bumps get special care

**Bumping oxlint or oxfmt's version is a dependency-bump checklist item, not a plain version-string
edit.** A newer formatter release can change what it considers correctly formatted, silently
invalidating files nobody touched. Whenever either tool's version changes, run the reformat (not just
the check) across all three workspaces from the repo root in the **same commit** as the bump, and
commit whatever it touches:

```sh
npx --prefix backend oxfmt backend frontend blocks   # reformats — not --check
npx oxlint                                            # from backend/, frontend/ and blocks/ each
```

Then confirm `npx --prefix backend oxfmt --check backend frontend blocks` exits clean before
pushing. Skipping this step is exactly how a version bump ships a red CI gate with nothing wrong in
the code itself.

## Why Vue template attributes never hold two statements

**Never put two statements in a Vue template attribute.** `@click="doOne(); doTwo()"` builds today
and is a build error the moment the file is formatted, because `semi: false` and Vue disagree about
the same character. Vue's `transformOn` decides whether an inline handler is a statement block or an
expression from `exp.content.includes(';')` — with the semicolon it emits `$event => { … }`,
without it `$event => ( … )`. oxfmt breaks the handler across lines and drops the semicolon, so Vue
parenthesises two statements and the template fails to compile (`Error parsing JavaScript
expression: Unexpected token`). Write a named handler instead — `@click="closeAndRefresh"` — as
`EditorMarkdown.vue` and `PageRelationDialog.vue` do.

Neither side of that is worth reconfiguring, so don't try — neither the compiler nor the formatter
can be fixed here. For a one-off where the inline form genuinely reads better, `<!-- prettier-ignore -->`
on the preceding line works (oxfmt honors Prettier's marker; there is no `oxfmt-ignore`).
