#!/usr/bin/env bash
#
# The lane is report-only, but this script still exits non-zero on a failure: a step that cannot
# fail renders as a plain green tick nobody reads, whereas with `continue-on-error: true` on the
# calling step a non-zero exit renders as GitHub's failed-but-continued marker. That step setting,
# not an always-zero exit here, is what keeps a red lane from blocking a merge or a release.

set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <workspace> [<workspace> ...]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Unset means "not running on Actions": the summary goes to a scratch file so the identical code
# path runs locally, printed at the end.
SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-}"
LOCAL_SUMMARY=0
if [ -z "$SUMMARY_FILE" ]; then
  SUMMARY_FILE="$(mktemp)"
  LOCAL_SUMMARY=1
fi

failed_lanes=()
summary_rows=()

for workspace in "$@"; do
  workspace_dir="$REPO_ROOT/$workspace"

  if [ ! -d "$workspace_dir" ]; then
    echo "::error title=Quarantine lane::No such workspace directory: $workspace"
    failed_lanes+=("$workspace")
    summary_rows+=("| \`$workspace/\` | :x: workspace not found | - |")
    continue
  fi

  # Output streams straight through rather than being captured: a lane that hangs should still show
  # what it got to, and nothing here needs the text.
  echo "--- quarantine lane: $workspace ---"
  (cd "$workspace_dir" && npm run --silent test:flaky)
  lane_status=$?

  if [ "$lane_status" -eq 0 ]; then
    summary_rows+=("| \`$workspace/\` | :white_check_mark: passed | \`npm run test:flaky\` |")
  else
    failed_lanes+=("$workspace")
    summary_rows+=("| \`$workspace/\` | :x: **FAILED** (exit $lane_status) | \`npm run test:flaky\` |")
    # `::error::` rather than `::warning::`: what makes the lane non-blocking is the step's
    # `continue-on-error`, not a claim that a red lane does not matter.
    echo "::error title=Quarantine lane failed ($workspace)::A quarantined test in $workspace/ failed. This does NOT block the merge or the release -- the lane is report-only by design. It does mean the test is still fragile, or has started failing for a real reason. Every lane member carries a dated expiry; check it."
  fi
done

{
  echo "## Quarantine lane (report-only)"
  echo
  echo "The \`*.flaky.*\` lane runs separately and gates nothing."
  echo "A red lane below is a signal, not a build failure."
  echo
  echo "| Workspace | Result | Command |"
  echo "| --- | --- | --- |"
  printf '%s\n' "${summary_rows[@]}"
  echo
  if [ "${#failed_lanes[@]}" -gt 0 ]; then
    echo "**${#failed_lanes[@]} lane(s) failed:** ${failed_lanes[*]}. The job still succeeds."
  else
    echo "All lanes green. An empty lane counts as green and is expected -- three of the four are"
    echo "empty today, and the lane is meant to stay small."
  fi
} >>"$SUMMARY_FILE"

if [ "$LOCAL_SUMMARY" -eq 1 ]; then
  echo
  echo "--- job summary (GITHUB_STEP_SUMMARY unset, printed instead) ---"
  cat "$SUMMARY_FILE"
  rm -f "$SUMMARY_FILE"
fi

if [ "${#failed_lanes[@]}" -gt 0 ]; then
  exit 1
fi

echo "::notice title=Quarantine lane::All quarantine lanes passed ($*)."
