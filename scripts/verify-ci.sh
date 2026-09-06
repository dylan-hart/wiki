#!/usr/bin/env bash
#
# verify-ci -- run CI's quality gate, here, inside the pinned parity image.
# OpenProject #2686, under Feature #2601 / Epic #2600.
#
# THE BAR THIS COMMAND EXISTS TO MAKE TRUE
#
#   A fix for a failing test is verified when it is green in the parity container, not when it is
#   green on the host.
#
# Epic #2600's measured cause was fixes marked resolved after passing on a Node 25.9 host and then
# failing on CI's Node 26. `.devcontainer/` (#2684) is the image that closes that gap; this script
# is what you actually run inside it. It mirrors .github/workflows/quality.yml step for step -- if
# the two ever drift, the bar is a lie, so backend/test/verifyCi.test.ts parses that workflow and
# fails when a gate command exists there and not here.
#
# It is deliberately NOT a convenience wrapper that "runs the tests": it runs every gate command
# quality.yml runs, in the same order, and it refuses to run at all outside the pinned image unless
# you explicitly opt out of the whole point of it (VERIFY_CI_ALLOW_HOST=1).
#
# Usage:      ./scripts/verify-ci.sh [options]
#             npm --prefix backend run verify:ci -- [options]
# Help:       ./scripts/verify-ci.sh --help   (the scope decisions are written out there)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

RUN_E2E=0
RUN_FLAKY=1
RUN_SMOKE_BOOT=0
RUN_INSTALL=0

usage() {
  cat <<'USAGE'
verify-ci -- run CI's quality gate inside the pinned parity image.

  ./scripts/verify-ci.sh [--install] [--e2e] [--smoke-boot] [--no-flaky]

WHAT IT RUNS BY DEFAULT

  Exactly the steps of .github/workflows/quality.yml's `quality` job, in its order:

    backend    npm run typecheck
    backend    npx oxlint --deny-warnings
    backend    npm run test
    backend    npm run block-locale-keys:check
    frontend   npm run icons:check
    frontend   npm run emoji:check
    frontend   npm run i18n:check
    frontend   npm run locales:check
    frontend   npm run notify-check
    frontend   npx oxlint --deny-warnings
    frontend   npm run test
    blocks     npm run locale-keys:check
    blocks     npx oxlint --deny-warnings
    blocks     npm run test
    <root>     npx --prefix backend oxfmt --check backend frontend blocks

  That list is longer than "typecheck, lint, test, format" on purpose: six drift checks
  (icons/emoji/i18n/locales/notify/locale-keys, two of them outside frontend/) are part of the gate
  and are the steps most likely to be forgotten by a hand-run verification.

  It stops at the first failure, the way a GitHub Actions job does (`continue-on-error: false`).

PRECONDITIONS -- checked before anything runs

  * the running Node is EXACTLY .devcontainer/Dockerfile's `ARG NODE_VERSION`;
  * pandoc and git-cliff are on PATH (quality.yml installs both onto the runner; the image has
    them. Without pandoc, backend/models/import.test.ts's real-pandoc test silently skips);
  * a Playwright browser directory exists (without it, frontend/'s two "real layout" describes
    silently skip -- see frontend/test/realGridLayout.js's hasChromium() probe);
  * DATABASE_URL is set (without it, backend/test/db.ts's hasTestDatabase() gate skips every
    DB-backed suite -- roughly a fifth of the backend suite; see docs/testing-audit/backend.md).

  Any of these missing is a hard refusal, because a run that skips a fifth of the suite and prints
  "green" is precisely the false verification this Epic exists to eliminate. VERIFY_CI_ALLOW_HOST=1
  downgrades the refusal to a loud banner -- use it to run the gate on a host you know is not the
  image, and do not call the result "verified".

OPTIONS

  --install      Run `npm ci` in each workspace first, as quality.yml does on a cold runner. Off by
                 default: inside the parity container .devcontainer/app-init.sh has already done it,
                 and repeating it on every verification run costs minutes for nothing.
  --e2e          Additionally run the Playwright leg: `npm run build` in frontend/ and blocks/, then
                 `npm test` in e2e/. OFF BY DEFAULT, and not only because it is slow -- the e2e suite
                 is not part of quality.yml at all. It lives in build.yml's `build` job, which runs
                 only on a push to scarlett. Running it by default would make this command diverge
                 from the very gate it claims to mirror.
  --smoke-boot   Additionally run quality.yml's OTHER job, "Production Install Smoke Boot"
                 (`npm ci --omit=dev` in backend/, then boot against an unreachable database). Opt-in
                 because it replaces backend/node_modules with the production-shaped tree; the script
                 runs it last and restores the dev tree with `npm ci` afterwards.
  --no-flaky     Skip the quarantine lane (see below).
  -h, --help     This text.

THE QUARANTINE LANE (docs/decisions/flaky-test-quarantine.md)

  After the gate passes, `npm run test:flaky` runs in all four workspaces REPORT-ONLY: its result is
  printed and NEVER changes this command's exit code. That mirrors the report-only lane step in
  quality.yml (OpenProject #2692) -- report-only on both sides is what makes the two agree on the
  pass/fail verdict regardless of which landed first. The lane holds one test today
  (backend/mcp/http.flaky.test.ts, expiry 2026-12-06); the other three lanes are empty and exit 0.

WHAT THIS COMMAND DOES *NOT* COVER

  * release.yml is not a separate mode: its gate (typecheck, three lints, icons/emoji/locales, the
    repo-wide oxfmt check) is a strict subset of quality.yml's, so a green run here covers it.
  * The Docker build/push legs of build.yml and release.yml. Nothing about them is reproducible as a
    local pass/fail verdict, and neither is a test gate.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --install) RUN_INSTALL=1 ;;
    --e2e) RUN_E2E=1 ;;
    --smoke-boot) RUN_SMOKE_BOOT=1 ;;
    --no-flaky) RUN_FLAKY=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "verify-ci: unknown option '$1'" >&2
      echo "Try './scripts/verify-ci.sh --help'." >&2
      exit 2
      ;;
  esac
  shift
done

# --------------------------------------------------------------------------------------------
# Output helpers. No colour when stdout is not a terminal, so a captured log stays readable.
# --------------------------------------------------------------------------------------------
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_OFF=$'\033[0m'
else
  C_BOLD=''
  C_RED=''
  C_GREEN=''
  C_YELLOW=''
  C_OFF=''
fi

banner() { printf '\n%s==> %s%s\n' "$C_BOLD" "$1" "$C_OFF"; }
note() { printf '    %s\n' "$1"; }
warn() { printf '%s!!  %s%s\n' "$C_YELLOW" "$1" "$C_OFF"; }
die() {
  printf '%sxx  %s%s\n' "$C_RED" "$1" "$C_OFF" >&2
  exit 1
}

LOG_DIR="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR"' EXIT

STEP_RESULTS=()
FLAKY_RESULTS=()
BACKEND_SKIPPED=''

print_summary() {
  banner 'Summary'
  local line
  if [ ${#STEP_RESULTS[@]} -gt 0 ]; then
    for line in "${STEP_RESULTS[@]}"; do
      note "$line"
    done
  fi
  if [ -n "$BACKEND_SKIPPED" ] && [ "$BACKEND_SKIPPED" != '0' ]; then
    warn "backend: ${BACKEND_SKIPPED} test(s)/suite(s) SKIPPED -- green does not mean everything ran."
  fi
}

# run_step <label> <workspace-dir-or-.> <command...>
#
# The `run_step` lines further down are the machine-readable half of this script:
# backend/test/verifyCi.test.ts reads every invocation out of this file and cross-checks the set
# against quality.yml's own steps. Keep them one per line and literal -- a command assembled from a
# variable is invisible to that scan, exactly as blocks/'s `static definition` literals are to theirs.
run_step() {
  local label="$1" dir="$2"
  shift 2
  local slug
  slug="$(printf '%s' "$label" | tr -c 'A-Za-z0-9' '-')"
  local log="${LOG_DIR}/${slug}.log"

  banner "$label  (${dir} \$ $*)"
  if (cd "${REPO_ROOT}/${dir}" && "$@") 2>&1 | tee "$log"; then
    STEP_RESULTS+=("ok    ${label}")
  else
    STEP_RESULTS+=("FAIL  ${label}")
    print_summary
    die "${label} failed. CI would stop here too."
  fi

  # A "green" backend run that never executed a fifth of its own suite is the caveat this Epic is
  # about (docs/testing-audit/backend.md), so what did not run is surfaced beside the verdict rather
  # than left in the scrollback.
  #
  # Counting the reporter's `# SKIP` markers rather than reading its `skipped N` summary line is
  # deliberate: that counter only counts skipped *tests*. This codebase's convention is
  # `describe(..., { skip: !hasTestDatabase() })` -- a whole-suite skip, which node reports as one
  # `# SKIP` line and as `skipped 0`. The summary line would therefore have said "0" for exactly the
  # case worth warning about.
  if [ "$label" = 'Backend Tests' ]; then
    BACKEND_SKIPPED="$(grep -c '# SKIP' "$log" || true)"
  fi
}

# --------------------------------------------------------------------------------------------
# Preconditions.
# --------------------------------------------------------------------------------------------
pinned_node="$(sed -n 's/^ARG NODE_VERSION=\([^ ]*\)$/\1/p' "${REPO_ROOT}/.devcontainer/Dockerfile" | head -n 1)"
[ -n "$pinned_node" ] || die 'could not read ARG NODE_VERSION from .devcontainer/Dockerfile.'

problems=()
running_node="$(node -v)"
[ "$running_node" = "v${pinned_node}" ] ||
  problems+=("Node is ${running_node}, but the parity image pins v${pinned_node} (.devcontainer/Dockerfile).")
command -v pandoc > /dev/null 2>&1 ||
  problems+=('pandoc is not on PATH; backend/models/import.test.ts would silently skip its real-pandoc test.')
command -v git-cliff > /dev/null 2>&1 ||
  problems+=('git-cliff is not on PATH; backend/test/changelog.test.ts needs it.')
[ -d "${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/.cache/ms-playwright}" ] ||
  problems+=("no Playwright browser found; frontend/'s two real-layout describes would silently skip.")
[ -n "${DATABASE_URL:-}" ] ||
  problems+=('DATABASE_URL is unset; every DB-backed backend suite would silently skip.')

if [ ${#problems[@]} -gt 0 ]; then
  if [ "${VERIFY_CI_ALLOW_HOST:-}" = '1' ]; then
    warn '================================================================'
    warn ' VERIFY_CI_ALLOW_HOST=1 -- this is NOT a parity run.'
    warn ' Whatever it prints, the result does not mean "verified".'
    warn '================================================================'
    for problem in "${problems[@]}"; do warn "$problem"; done
  else
    printf '%sxx  verify-ci refuses to run: this is not the parity environment.%s\n' "$C_RED" "$C_OFF" >&2
    for problem in "${problems[@]}"; do printf '    - %s\n' "$problem" >&2; done
    printf '\n    Run this inside the .devcontainer image (OpenProject #2684), where all of the above\n' >&2
    printf '    hold by construction. To run anyway on a host you know is not the image, set\n' >&2
    printf '    VERIFY_CI_ALLOW_HOST=1 -- and do not call the result verified.\n' >&2
    exit 1
  fi
fi

banner "verify-ci: mirroring .github/workflows/quality.yml on Node ${running_node}"
note "repo: ${REPO_ROOT}"

# --------------------------------------------------------------------------------------------
# Installs. Off by default; see --help.
# --------------------------------------------------------------------------------------------
if [ "$RUN_INSTALL" = '1' ]; then
  run_step 'Install Backend Dependencies' backend npm ci
  run_step 'Install Frontend Dependencies' frontend npm ci
  run_step 'Install Blocks Dependencies' blocks npm ci
  if [ "$RUN_E2E" = '1' ]; then
    run_step 'Install E2E Dependencies' e2e npm ci
  fi
fi

# --------------------------------------------------------------------------------------------
# The gate itself, in quality.yml's order.
# --------------------------------------------------------------------------------------------
run_step 'Backend Typecheck' backend npm run typecheck
run_step 'Backend Lint' backend npx oxlint --deny-warnings
run_step 'Backend Tests' backend npm run test
run_step 'Backend Block Locale Keys Check' backend npm run block-locale-keys:check
run_step 'Frontend Icons Check' frontend npm run icons:check
run_step 'Frontend Emoji Check' frontend npm run emoji:check
run_step 'Frontend i18n Source Check' frontend npm run i18n:check
run_step 'Frontend Locales Check' frontend npm run locales:check
run_step 'Frontend Notify err.message Check' frontend npm run notify-check
run_step 'Frontend Lint' frontend npx oxlint --deny-warnings
run_step 'Frontend Tests' frontend npm run test
run_step 'Blocks Locale Keys Check' blocks npm run locale-keys:check
run_step 'Blocks Lint' blocks npx oxlint --deny-warnings
run_step 'Blocks Tests' blocks npm run test
run_step 'Format Check' . npx --prefix backend oxfmt --check backend frontend blocks

# --------------------------------------------------------------------------------------------
# The Playwright leg (build.yml's `build` job, not quality.yml). Opt-in; see --help.
# --------------------------------------------------------------------------------------------
if [ "$RUN_E2E" = '1' ]; then
  run_step 'Build Assets' frontend npm run build
  run_step 'Build Blocks' blocks npm run build
  run_step 'Run E2E Smoke Suite' e2e npm test
fi

# --------------------------------------------------------------------------------------------
# quality.yml's other job: Production Install Smoke Boot. Opt-in; see --help.
#
# One deliberate divergence, and it is in this script's favour: quality.yml copies config.sample.yml
# over config.yml because a fresh runner has neither, and it gets an unreachable database for free by
# having no postgres service in that job. Neither holds here -- a dev checkout's config.yml is real
# and the parity container's database IS up -- so the boot runs against a throwaway config pointed at
# a dead port, with DATABASE_URL unset (core/db.ts prefers it outright whenever it is set). Same
# assertion, nothing of yours overwritten.
# --------------------------------------------------------------------------------------------
if [ "$RUN_SMOKE_BOOT" = '1' ]; then
  banner 'Production Install Smoke Boot  (backend $ npm ci --omit=dev; node backend)'
  warn 'This replaces backend/node_modules with the production tree; the dev tree is restored after.'

  smoke_config="${LOG_DIR}/config.smoke.yml"
  sed 's/^  port: 5432$/  port: 1/' "${REPO_ROOT}/config.sample.yml" > "$smoke_config"

  smoke_log="${LOG_DIR}/smoke-boot.log"
  smoke_status=0
  (cd "${REPO_ROOT}/backend" && npm ci --omit=dev) || smoke_status=1

  if [ "$smoke_status" = '0' ]; then
    set +e
    (cd "$REPO_ROOT" && env -u DATABASE_URL CONFIG_FILE="$smoke_config" timeout 20s node backend) \
      > "$smoke_log" 2>&1
    set -e
    cat "$smoke_log"

    if grep -qE 'ERR_MODULE_NOT_FOUND|Cannot find (package|module)' "$smoke_log"; then
      warn 'A devDependency has leaked onto the real boot path -- see docs/variances.md.'
      smoke_status=1
    elif ! grep -q 'Database connection error' "$smoke_log"; then
      warn 'Boot never reached the database-connect stage, so this asserted nothing useful.'
      smoke_status=1
    fi
  fi

  banner 'Restoring the development install (backend $ npm ci)'
  (cd "${REPO_ROOT}/backend" && npm ci)

  if [ "$smoke_status" = '0' ]; then
    STEP_RESULTS+=('ok    Production Install Smoke Boot')
  else
    STEP_RESULTS+=('FAIL  Production Install Smoke Boot')
    print_summary
    die 'Production Install Smoke Boot failed. CI would stop here too.'
  fi
fi

# --------------------------------------------------------------------------------------------
# The quarantine lane -- REPORT-ONLY. Never touches the exit code. See --help and
# docs/decisions/flaky-test-quarantine.md.
# --------------------------------------------------------------------------------------------
if [ "$RUN_FLAKY" = '1' ]; then
  for workspace in backend frontend blocks e2e; do
    banner "Quarantine lane (report-only): ${workspace} \$ npm run test:flaky"
    if (cd "${REPO_ROOT}/${workspace}" && npm run test:flaky); then
      FLAKY_RESULTS+=("ok    ${workspace}")
    else
      FLAKY_RESULTS+=("FAIL  ${workspace}  (report-only -- does not fail this run)")
    fi
  done
fi

print_summary

if [ ${#FLAKY_RESULTS[@]} -gt 0 ]; then
  banner 'Quarantine lane (report-only, not part of the bar)'
  for result in "${FLAKY_RESULTS[@]}"; do
    note "$result"
  done
fi

banner "${C_GREEN}PASSED${C_OFF} -- the CI quality gate is green on Node ${running_node}."
if [ -n "${VERIFY_CI_ALLOW_HOST:-}" ]; then
  warn 'Ran with VERIFY_CI_ALLOW_HOST -- this was not a parity run and does not count as verified.'
fi
