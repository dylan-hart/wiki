# Decision: `WInput`/`WSelect` autofocus is a component prop, layered under `useDialogComponent` for dialogs

Status: Decided — both candidate implementations already shipped and were reconciled in the tree
Date: 2026-08-31
Related: Epic #1661 ("Wire the 17 dialogs whose dead `<w-input autofocus>` attribute never focuses
anything"), Task #1664 (this decision), Feature #1613 → Task #1618, Bug #1649, Task #1796, Task #1606
("Implement the modal contract in `WDialog`"), `frontend/src/components/shared/WInput.vue`,
`frontend/src/components/shared/WSelect.vue`, `frontend/src/composables/dialog.js`,
`frontend/src/components/shared/WDialog.vue`

## Context

Two audit findings, read independently, prescribed opposite fixes for the same defect (25 templates
writing an inert `autofocus`/`:autofocus` attribute on `<w-input>`, since its single root is a
wrapper `<div>` that fallthrough attributes land on instead of the real `<input>`/`<textarea>`):

- `docs/audit-2026-08-24/maintainability.md` §3 said **do not** add an `autofocus` prop to
  `WInput.vue`. Its argument: "focus is an action taken at a moment, not a state of the component: a
  dialog that reopens with the same props has to be able to ask again" (citing the precedent at
  `UtilCodeEditor.vue:232-235`), so every call site should instead be wired through
  `useDialogComponent({ autofocus: () => iptX.value })`.
- `docs/audit-2026-08-24/ux-flows.md` §9 said fix it **at the component** with a declared boolean
  `autofocus` prop, correcting all 25 call sites with no per-file change.

Both agreed that `inheritAttrs: false` + bare `v-bind="$attrs"` alone would be wrong on its own,
since it would also relocate every `class`/`style` a call site puts on `<w-input>` onto the inner
control.

Three work packages were independently filed and independently implemented against these two
prescriptions before this decision was written down, and by the time this task was picked up all
three had already landed on `scarlett`:

- **Task #1618** ("Give `WInput` and `WSelect` a working `autofocus` and forward the remaining
  attributes to the real control", child of Feature #1613) — the `maintainability.md`-adjacent
  implementation: `autofocus` prop plus `inheritAttrs: false` + explicit `v-bind` of the remaining
  attrs. Closed, landed in PR #13.
- **Bug #1649** ("Give `WInput` a real autofocus prop so the 25 existing autofocus attributes stop
  being no-ops") — a second, independently-filed statement of the `ux-flows.md` side, whose own
  description already flagged the conflict with this decision task and with #1618/#1796 before
  landing. Closed, landed in PR #26.
- **Task #1796** ("Forward `$attrs` from `WInput` to its inner control, add a real `autofocus` prop,
  and validate the two numeric fields", child of Feature #1784) — a third, independently-filed
  overlap covering the same `inheritAttrs`/`autofocus` mechanism plus unrelated numeric-field
  validation. Closed, landed in PR #24.

None of the three PRs were merged into `scarlett` at the same time as each other, so the described
risk of "whichever lands first wins arbitrarily" was real — but the consolidated overnight merge that
folded all pending branches into `scarlett` (`a3a6c799`) reconciled them into one implementation
rather than picking one and dropping the other two's work.

## Decision

**The mechanism is a component prop**, per `ux-flows.md` — not a purely per-call-site
`useDialogComponent`-only fix. `WInput.vue` and `WSelect.vue` each declare a boolean `autofocus`
prop that calls the already-exposed `focus()` in `onMounted` (a no-op for `type="hidden"`, which
cannot take focus). This is the single fix `ux-flows.md` argued for: it corrects every non-dialog
call site with no per-file change, and it also does what `maintainability.md`'s "focus is an action,
not a state" objection is really protecting against — see the dialog case below, which the
`inheritAttrs: false` + prop combination does not undermine.

The shipped code additionally took `maintainability.md`'s more complete route on **attribute
forwarding**, which is a separate axis from the autofocus question: `defineOptions({ inheritAttrs:
false })` plus an explicit `v-bind="controlAttrs"` (computed as `attrs` minus `class`/`style`, which
stay bound to the wrapper) onto the real control. This is what rescues `name`, `inputmode`,
`maxlength`, `aria-label`, and `min`/`max`/`step` for numeric fields — none of which `ux-flows.md`'s
narrower "just add an `autofocus` prop" fix would have touched, and all of which were real, separate
defects (Task #1796's numeric-field scope). `autofocus` itself is kept **out** of `$attrs` by being a
declared prop rather than left to fall through, so it never sits inertly on the wrapper alongside the
other forwarded attributes.

**Dialogs keep `composables/dialog.js`'s `useDialogComponent({ autofocus: () => iptX.value })`
instead of the bare prop**, and this is not a leftover — it is load-bearing, for a reason specific to
`WDialog`'s modal contract (Task #1606), not just "the field isn't mounted yet":

- `WDialog` renders its panel only while open, and moves focus into it **synchronously** on open —
  the first tabbable descendant, or the panel itself if none exists — as part of the focus-trap entry
  every dialog needs regardless of whether it declares its own preferred field (`WDialog.vue`'s
  `moveFocusIntoPanel`).
- `useDialogComponent`'s `autofocus` runs its own `onMounted → nextTick → nextTick` chain, which
  necessarily resolves in a **later microtask** than that synchronous panel-entry focus. That
  ordering is what makes it a deliberate override rather than a race — the dialog's own focus-trap
  entry always runs first and is always superseded by the explicit `autofocus` target when one is
  given (`WDialog.vue`'s own comment at the `moveFocusIntoPanel` definition spells this out).
- A bare `WInput autofocus` prop *inside* a dialog would fire from the input's own `onMounted`
  instead, with no guaranteed ordering against `WDialog`'s synchronous panel-entry focus — exactly
  the kind of implicit race `maintainability.md`'s "not a race" framing (`UtilCodeEditor.vue:232-235`)
  was arguing against, just resolved by keeping the override explicit and by-reference at the dialog
  level instead of not having a component prop at all.

So the working split, as verified against `AuthLoginPanel.vue` and `ApprovalRuleDialog.vue`:

- A field whose mount timing already is the moment it should take focus — a conditionally-rendered,
  non-dialog field (`AuthLoginPanel.vue`'s TFA recovery-code input, toggled by `v-if`/`v-else`) — uses
  the `autofocus` prop directly.
- A field inside a `WDialog` panel uses `useDialogComponent({ autofocus: () => iptX.value })`, never
  the bare prop, so it composes correctly with the dialog's own focus-trap entry.
- A field with genuinely bespoke focus timing (`AuthLoginPanel.vue`'s login username field, which
  must not steal focus back after a reset-token redirect already switched screens) keeps its own
  explicit `onMounted`/`nextTick` call rather than either mechanism — this was always going to be a
  case-by-case call, and the component prop existing does not force it everywhere.

## Disposition of the competing work packages

Per this task's own done-when criterion, the competing "give `WInput` a real autofocus prop" work is
**adopted as the implementation**, not closed as superseded — because the two audit prescriptions
were not, in practice, mutually exclusive once combined with the (also-agreed) attribute-forwarding
fix. All three concrete work packages that carried out either side are already Closed, and their
code is reconciled — not merely both present and silently conflicting — in the current `WInput.vue`/
`WSelect.vue` on `scarlett`:

- Task #1618 — Closed, adopted (the `useDialogComponent` retention + `inheritAttrs`/forwarding half).
- Bug #1649 — Closed, adopted (the declared `autofocus` prop half).
- Task #1796 — Closed, adopted (the `$attrs` forwarding mechanics plus the unrelated numeric-field
  validation, out of scope for this decision but shipped alongside it).

No further work package needs to be opened, closed, or reworked as a result of this decision; this
note exists to make the reconciled outcome explicit rather than leaving three closed WPs' worth of
independently-arrived-at code looking like an unresolved conflict to the next reader.
