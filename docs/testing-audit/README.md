# Test-value audit

A one-shot, human-judged classification of what each test suite in this repository actually gates.

Produced for OpenProject Feature **#2602** ("Re-proportion the suite"). It is evidence for the
testing policy (**#2689**, landing as `docs/decisions/testing-strategy.md`) and for the `backend/`
pruning pass (**#2690**). It is not a gate, is not re-run in CI, and authorises no deletion by
itself.

| file | covers | work package |
| --- | --- | --- |
| `backend.md` | `backend/`'s 397 suites | #2687 |
| `frontend.md` | `frontend/`'s 305 suites | #2688 (not yet landed) |
| `metrics.mjs` | the objective numbers, for every workspace | #2687 |
| `backend-metrics.txt` | committed output of `node docs/testing-audit/metrics.mjs` | #2687 |

## The schema every classification document uses

Fixed by #2687 so the two halves can be aggregated without a reconciliation pass. A new document
here matches it rather than inventing its own.

- **Categories are exactly Feature #2602's four, verbatim and unabbreviated**: *product behaviour*,
  *framework behaviour*, *implementation restatement*, *environment*. No fifth label, no renaming.
  Tables abbreviate them to the numbers 1–4 with a legend.
- **Columns are fixed**: `path | category | one-line reason | what gates this behaviour if the file
  goes away`.
- **Column 4 is mandatory for every row that is not purely category 1.** Feature #2602's rule is
  "deleting a test is only safe if the audit says what gates that behaviour instead"; a `—` there
  means the row is category 1 and nothing else covers it.
- **A mixed file says so with a rough share** (`1 product / 3 restatement (~70/30)`) rather than
  being forced into one label. The rollup counts it once, under the first category named.
- **The document records the exact enumeration command and the commit SHA it was taken at**, so the
  denominator is reproducible and drift is visible.
- **Category-4 rows are also listed flat**, in one place, because that list is #2691's quarantine
  candidate set and nothing else in the Epic tree produces it.

## What is not scripted

The category and the reason. Feature #2602's resolved scope is explicit that the classification is a
judgement a heuristic cannot make well and that "the value here is the decisions, not the ability to
re-run them." `metrics.mjs` counts files, lines, test cases and mechanically-detectable properties
(does this suite open a real database, boot Fastify, sit behind a skip gate); it assigns no
category, and it is deliberately not wired into any `npm run` script.

`metrics.mjs` lives here rather than under a workspace on purpose: a file under `backend/` would be
picked up by that workspace's `oxlint`, `oxfmt` and `tsc`, and would sit in the middle of the
tree #2690 is about to prune.
