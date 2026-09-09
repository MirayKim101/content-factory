#!/usr/bin/env bash
# Bash 3-compatible, dependency-free behavior checks for the benchmark runner.
set -Eeuo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly RUNNER="$REPO_ROOT/scripts/benchmarks/run-parallel-cut-benchmark.sh"
readonly MOCK_BIN="$REPO_ROOT/scripts/benchmarks/test-fixtures/mock-bin"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/parallel-cut-runner-test.XXXXXX")"
trap 'rm -rf "$tmp_root"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
run_case() {
  local name="$1" level="$2" expected_status="$3" expected_compose_count="$4" expected_post_count="$5"
  shift 5
  local state="$tmp_root/$name"
  mkdir -p "$state/results"
  printf '1' >"$state/concurrency"
  set +e
  PATH="$MOCK_BIN:$PATH" MOCK_STATE="$state" BENCHMARK_RESULT_ROOT="$state/results" "$@" "$RUNNER" "$level"
  status=$?
  set -e
  [[ "$status" == "$expected_status" ]] || fail "$name status=$status expected=$expected_status"
  action_count=0
  if [[ -f "$state/actions" ]]; then action_count="$(grep -c '^compose ' "$state/actions" || true)"; fi
  [[ "$action_count" == "$expected_compose_count" ]] \
    || fail "$name compose count differs; unsafe EXIT restoration may have returned"
  post_count=0
  if [[ -f "$state/curl-actions" ]]; then post_count="$(grep -c -- '-X POST' "$state/curl-actions" || true)"; fi
  [[ "$post_count" == "$expected_post_count" ]] || fail "$name POST count=$post_count expected=$expected_post_count"
}

bash -n "$RUNNER"
run_case level1 1 0 1 1 env
run_case level2 2 0 2 1 env
run_case low_memory_before_mutation 2 1 0 0 env MOCK_LOW_MEMORY=1
run_case unknown_memory_before_mutation 2 1 0 0 env MOCK_UNKNOWN_MEMORY=1
run_case queue_appears_during_preflight 2 1 0 0 env MOCK_ACTIVE_ON_SECOND=1
run_case low_memory_after_compose 2 1 1 0 env MOCK_LOW_AFTER_COMPOSE=1
run_case unknown_memory_after_post 2 1 1 1 env MOCK_UNKNOWN_RUNTIME=1 MOCK_ACTIVE_STATUS=1
run_case ffprobe_failure_no_restore 2 1 1 1 env MOCK_BAD_FFPROBE=1
printf 'PASS: Bash syntax, drained-only restoration, pre-mutation and post-compose memory rejection, queue-race rejection, unknown runtime memory stop, and FFprobe failure with no unsafe restore.\n'
