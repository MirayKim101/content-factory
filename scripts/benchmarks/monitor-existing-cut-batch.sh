#!/usr/bin/env bash
# Read-only, resumable monitor for a batch that already exists. It deliberately
# has no Compose, queue, restart, submission, cleanup, or deletion operation.
set -Eeuo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly API_BASE_URL="${BENCHMARK_API_BASE_URL:-http://127.0.0.1:3001/api/v1}"
readonly PROJECT_ID="${BENCHMARK_PROJECT_ID:-ef703380-656e-4f15-9c5e-f722c7bbe01b}"
readonly WORKER="content-factory-media-worker-1"
readonly INTERVAL_SECONDS="${BENCHMARK_SAMPLE_INTERVAL_SECONDS:-15}"
readonly TZ_NAME="Asia/Novosibirsk"

[[ $# -eq 1 ]] || { printf 'Usage: %s <existing-run-directory>\n' "${0##*/}" >&2; exit 64; }
readonly RUN_DIR="$1"
readonly JOB_FILE="$RUN_DIR/job-ids.txt"
[[ -d "$RUN_DIR" && -s "$JOB_FILE" ]] || { printf 'Run directory requires job-ids.txt.\n' >&2; exit 64; }
for command in curl docker jq; do command -v "$command" >/dev/null 2>&1 || exit 69; done

timestamp() { TZ="$TZ_NAME" date '+%Y-%m-%dT%H:%M:%S%z'; }
readonly IDS_JSON="$(jq -Rsc 'split("\n") | map(select(length > 0))' "$JOB_FILE")"

sample() {
  local now
  now="$(timestamp)"
  docker exec content-factory-postgres-1 psql --csv -U content_factory -d content_factory \
    -c "SELECT p.id, p.state, p.\"attemptCount\", p.\"startedAt\", p.\"finishedAt\", p.\"heartbeatAt\", p.\"failureCode\", a.\"attemptNumber\", a.state AS attempt_state, a.\"workerId\" FROM \"PipelineJob\" p LEFT JOIN \"JobAttempt\" a ON a.\"jobId\" = p.id AND a.\"attemptNumber\" = p.\"attemptCount\" WHERE p.id IN ($(sed "s/^/'/;s/$/'/" "$JOB_FILE" | paste -sd, -)) ORDER BY p.id;" \
    | sed "s/^/$now,/" >>"$RUN_DIR/incident-job-monitor.csv"
  docker stats --no-stream --format "${now} {{.Name}} {{.CPUPerc}} {{.MemUsage}} {{.MemPerc}} {{.PIDs}}" \
    >>"$RUN_DIR/incident-docker-stats.txt"
  docker exec "$WORKER" awk '/MemTotal:/ {total=$2} /MemAvailable:/ {available=$2} END {print available "/" total " KiB"}' /proc/meminfo \
    | sed "s/^/$now,vm_available,/" >>"$RUN_DIR/incident-vm-memory.csv"
  docker exec "$WORKER" sh -c 'df -B1 /tmp | awk "NR==2 {print \$3 \"/\" \$2}"; du -sb /tmp/media-worker /tmp/media-cache 2>/dev/null' \
    | sed "s/^/$now,/" >>"$RUN_DIR/incident-worker-storage-and-processes.csv"
  docker top "$WORKER" -eo pid,etime,pcpu,pmem,args \
    | sed "s/^/$now,/" >>"$RUN_DIR/incident-process-samples.txt"
}

terminal_state() {
  curl --fail --silent --show-error "$API_BASE_URL/projects/$PROJECT_ID/pipeline-jobs" >"$RUN_DIR/incident-latest-jobs.json"
  jq -e --argjson ids "$IDS_JSON" \
    '[.items[] | select(.id as $id | $ids | index($id))] | length == 4 and all(.[]; .state == "READY" or .state == "FAILED_FINAL")' \
    "$RUN_DIR/incident-latest-jobs.json" >/dev/null
}

printf '%s read-only monitor resumed\n' "$(timestamp)" >>"$RUN_DIR/incident-monitor.log"
while :; do
  sample
  if terminal_state; then
    printf '%s all four jobs terminal; monitor stopped without mutating runtime.\n' "$(timestamp)" \
      | tee -a "$RUN_DIR/incident-monitor.log"
    exit 0
  fi
  sleep "$INTERVAL_SECONDS"
done
