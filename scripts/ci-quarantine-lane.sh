#!/usr/bin/env bash
#
# The quarantine lane's CI runner -- OpenProject #2692 (Feature #2603, Epic #2600).
#
# Runs `npm run test:flaky` in each workspace named as an argument and reports the result three
# ways: a markdown table appended to the job summary, a GitHub annotation per failed lane, and a
# non-zero exit code. The lane is REPORT-ONLY everywhere, so every call site sets
# `continue-on-error: true` on its step -- that, not an always-zero exit here, is what keeps a red
# lane from blocking a merge or a release.
#
# Why this script exits non-zero on a failed lane rather than swallowing it: a step that cannot
# fail renders as a plain green tick, indistinguishable from a lane that actually passed, and
# nobody looks at a step that is always green. With `continue-on-error: true` above it, a non-zero
# exit renders as GitHub's failed-but-continued marker -- visible on the run page, job still
# successful. That is the whole point of the step (#2692's spec item 3): a report-only lane whose
# result is invisible is a lane that rots.
#
# Why one script rather than the same twenty lines pasted into three workflow files: three copies
# of the summary/annotation logic is exactly the drift Epic #2600 exists to remove.
#
# See docs/decisions/flaky-test-quarantine.md -- the authority on what belongs in the lane, what
# each workspace's lane command is, and why an empty lane exits 0.
#
# Usage: scripts/ci-quarantine-lane.sh <workspace> [<workspace> ...]
#   e.g. scripts/ci-quarantine-lane.sh backend frontend blocks
#
# Runs fine outside GitHub Actions (GITHUB_STEP_SUMMARY unset -> the table is printed to stdout,
# and the ::error:: lines are just text), so a developer can reproduce a CI lane report locally.

set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <workspace> [<workspace> ...]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Unset means "not running on Actions": send the summary to a scratch file so the identical code
# path runs locally, then print it at the end.
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

  # Run in a subshell and let the runner's output stream straight through rather than capturing it:
  # a lane that hangs should still show what it got to, and nothing here needs the text.
  echo "--- quarantine lane: $workspace ---"
  (cd "$workspace_dir" && npm run --silent test:flaky)
  lane_status=$?

  if [ "$lane_status" -eq 0 ]; then
    summary_rows+=("| \`$workspace/\` | :white_check_mark: passed | \`npm run test:flaky\` |")
  else
    failed_lanes+=("$workspace")
    summary_rows+=("| \`$workspace/\` | :x: **FAILED** (exit $lane_status) | \`npm run test:flaky\` |")
    # One annotation per failed lane, so the run page names the workspace without anyone opening a
    # log. `::error::` rather than `::warning::` deliberately: what makes the lane non-blocking is
    # the step's `continue-on-error`, not a claim that a red lane does not matter.
    echo "::error title=Quarantine lane failed ($workspace)::A quarantined test in $workspace/ failed. This does NOT block the merge or the release -- the lane is report-only by design (docs/decisions/flaky-test-quarantine.md). It does mean the test is still fragile, or has started failing for a real reason. Every lane member carries a dated expiry; check it."
  fi
done

{
  echo "## Quarantine lane (report-only)"
  echo
  echo "The \`*.flaky.*\` lane runs separately and gates nothing -- see"
  echo "\`docs/decisions/flaky-test-quarantine.md\`. A red lane below is a signal, not a build failure."
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
