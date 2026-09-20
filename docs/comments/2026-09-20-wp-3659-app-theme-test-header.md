# WP 3659: stale comments in `frontend/src/App.theme.test.js`

The client no longer injects `injectCSS`/`injectHead`/`injectBody` (the server does, in the app
shell), so two comments there describe behaviour that is gone.

- File header, first bullet: the `enableJavaScriptEvaluation` rationale ("required for the
  injectHead/injectBody `<script>` assertions to actually run the script") is now inverted. Those
  tests assert the script does NOT run. Reword to say the flag makes the "no script runs"
  assertions meaningful, or trim it.
- File header, last paragraph ("The layer the per-helper suites don't cover ... WIRES each
  site-theme setting to its helper"): the per-helper suites for the injection helpers are deleted
  and only the font wiring remains. Trim to the font wiring.
- Block comment above the `/login` test ("there is no per-page injection call to gate"): no longer
  the point of the test, which now asserts nothing is injected client-side on a non-content route.
  Delete it.
