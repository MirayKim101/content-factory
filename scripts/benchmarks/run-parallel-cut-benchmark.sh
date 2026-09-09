#!/usr/bin/env bash
# Runs exactly one level of the bounded 1 -> 2 -> 4 media-worker experiment.
# It creates real, independently persisted results; never run it against a
# non-local deployment. Evidence is deliberately stored below tmp/, which is
# ignored by git and can be handed to an independent reviewer.
set -Eeuo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly COMPOSE_FILE="$REPO_ROOT/infrastructure/compose.yaml"
readonly PROJECT_ID="${BENCHMARK_PROJECT_ID:-ef703380-656e-4f15-9c5e-f722c7bbe01b}"
readonly SOURCE_ID="146f4b93-5ccd-420f-81fa-1179130da2f8"
readonly API_BASE_URL="${BENCHMARK_API_BASE_URL:-http://127.0.0.1:3001/api/v1}"
readonly RESULT_ROOT="${BENCHMARK_RESULT_ROOT:-$REPO_ROOT/tmp/benchmarks/parallel-cut}"
readonly WORKER="content-factory-media-worker-1"
readonly SAMPLE_INTERVAL_SECONDS="${BENCHMARK_SAMPLE_INTERVAL_SECONDS:-15}"
readonly MAX_LEVEL_SECONDS="${BENCHMARK_MAX_LEVEL_SECONDS:-14400}"
readonly VM_AVAILABLE_STOP_MIB="${BENCHMARK_VM_AVAILABLE_STOP_MIB:-1024}"
readonly VM_AVAILABLE_STOP_PERCENT="${BENCHMARK_VM_AVAILABLE_STOP_PERCENT:-15}"
readonly SOURCE_BYTES=3813099228
readonly OUTPUT_ADMISSION_BYTES=$((900 * 1024 * 1024))
readonly VM_RESERVE_BYTES=$((1024 * 1024 * 1024))
readonly TZ_NAME="Asia/Novosibirsk"

usage() {
  printf 'Usage: %s <1|2|4>\n' "${0##*/}" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage
readonly LEVEL="$1"
[[ "$LEVEL" =~ ^(1|2|4)$ ]] || usage

timestamp() {
  TZ="$TZ_NAME" date '+%Y-%m-%dT%H:%M:%S%z'
}

die() {
  printf '%s ERROR %s\n' "$(timestamp)" "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

[[ "$LEVEL" != '4' || "${BENCHMARK_LEVEL4_APPROVAL:-}" == 'measured-safe' ]] \
  || die 'Level 4 requires explicit independent-review approval after level-2 memory evidence: BENCHMARK_LEVEL4_APPROVAL=measured-safe.'

for command in curl docker jq uuidgen; do require_command "$command"; done
[[ -f "$REPO_ROOT/.env" ]] || die "Missing $REPO_ROOT/.env"

compose() {
  docker compose --env-file "$REPO_ROOT/.env" -f "$COMPOSE_FILE" "$@"
}

worker_health() {
  docker inspect "$WORKER" --format '{{.State.Health.Status}}' 2>/dev/null
}

worker_cpu_limit() {
  docker inspect "$WORKER" --format '{{.HostConfig.NanoCpus}}' 2>/dev/null
}

worker_concurrency() {
  docker exec "$WORKER" sh -c 'printf "%s\\n" "$MEDIA_WORKER_CONCURRENCY"' 2>/dev/null
}

active_jobs() {
  docker exec content-factory-postgres-1 psql -At -U content_factory -d content_factory \
    -c "SELECT count(*) FROM \"PipelineJob\" WHERE state IN ('QUEUED', 'PROCESSING', 'RETRY_WAIT');"
}

vm_memory_kib() {
  docker exec "$WORKER" awk '/MemTotal:/ {total=$2} /MemAvailable:/ {available=$2} END {print available " " total}' /proc/meminfo
}

assert_vm_admission() {
  local available_kib total_kib required_bytes available_bytes
  read -r available_kib total_kib <<<"$(vm_memory_kib)"
  [[ "$available_kib" =~ ^[0-9]+$ && "$total_kib" =~ ^[0-9]+$ && "$total_kib" -gt 0 ]] \
    || die 'Docker-VM MemAvailable/MemTotal is unavailable; fail closed before worker recreation or POST.'
  required_bytes=$(( SOURCE_BYTES + LEVEL * OUTPUT_ADMISSION_BYTES + VM_RESERVE_BYTES ))
  available_bytes=$(( available_kib * 1024 ))
  (( available_bytes >= required_bytes )) || die "Docker-VM admission rejected: need ${required_bytes} bytes for source cache + ${LEVEL} output budgets + 1 GiB reserve; only ${available_bytes} bytes available."
  printf '%s vm-admission available_bytes=%s total_kib=%s required_bytes=%s\n' \
    "$(timestamp)" "$available_bytes" "$total_kib" "$required_bytes" >>"$RUN_DIR/runner.log"
}

on_exit() {
  local status=$?
  printf '%s runner exit status=%s; no EXIT worker recreation is permitted.\n' \
    "$(timestamp)" "$status" >>"$RUN_DIR/runner.log"
  exit "$status"
}

restore_baseline_after_drain() {
  [[ "$LEVEL" != '1' ]] || return 0
  [[ "$(active_jobs)" == '0' ]] \
    || die 'Refusing baseline restoration while any job is active, queued, or retrying.'
  printf '%s restoring drained worker to concurrency=1 with fixed 2 CPU cap\n' \
    "$(timestamp)" | tee -a "$RUN_DIR/runner.log"
  MEDIA_WORKER_CONCURRENCY=1 compose up -d --force-recreate --no-deps media-worker >>"$RUN_DIR/runner.log" 2>&1
  for _ in $(seq 1 24); do
    [[ "$(worker_health)" == 'healthy' ]] && break
    sleep 5
  done
  [[ "$(worker_health)" == 'healthy' ]] || die 'Baseline worker did not become healthy after drained restoration.'
  [[ "$(worker_cpu_limit)" == '2000000000' && "$(worker_concurrency)" == '1' ]] \
    || die 'Drained restoration did not return to the fixed 2 CPU / concurrency 1 baseline.'
}

mkdir -p "$RESULT_ROOT"
readonly RUN_ID="level-${LEVEL}-$(TZ="$TZ_NAME" date '+%Y%m%dT%H%M%S%z')-$(uuidgen | tr '[:upper:]' '[:lower:]')"
readonly RUN_DIR="$RESULT_ROOT/$RUN_ID"
mkdir -p "$RUN_DIR"
touch "$RUN_DIR/runner.log"
trap on_exit EXIT

printf '%s preflight level=%s project=%s source=%s API=%s\n' \
  "$(timestamp)" "$LEVEL" "$PROJECT_ID" "$SOURCE_ID" "$API_BASE_URL" | tee -a "$RUN_DIR/runner.log"

[[ "$(active_jobs)" == '0' ]] || die 'Refusing to restart worker while a job is active, queued, or retrying.'
[[ "$(worker_health)" == 'healthy' && "$(worker_cpu_limit)" == '2000000000' && "$(worker_concurrency)" == '1' ]] \
  || die 'Experiment must begin from the healthy 2 CPU / concurrency 1 baseline.'
docker exec "$WORKER" /usr/bin/ffprobe -version >"$RUN_DIR/ffprobe-version.txt"
assert_vm_admission
curl --fail --silent --show-error "$API_BASE_URL/projects/$PROJECT_ID" >"$RUN_DIR/project-preflight.json"
SOURCE_ASSERTION='(.source.id == $sourceId) and (.source.status == "READY") and (.source.sourceVersion == 1) and (.source.sizeBytes == "3813099228") and (.source.sha256 == "99c0eba5e8d9c34e9736e39299524a438edefffa58ffff7b471296294bfc024a") and (.source.durationMs == 5878827) and (.source.authorization.status == "CLEARED") and (.source.authorization.usable == true) and (.source.authorization.sourceVersion == 1) and (.artifact.lineageSourceId == $sourceId) and (.artifact.lineageSourceVersion == 1) and (.artifact.sizeBytes == "3813099228") and (.artifact.sha256 == "99c0eba5e8d9c34e9736e39299524a438edefffa58ffff7b471296294bfc024a")'
jq -e --arg sourceId "$SOURCE_ID" "$SOURCE_ASSERTION" "$RUN_DIR/project-preflight.json" >/dev/null \
  || die 'Project/source/authorization/checksum preflight did not match the approved immutable source.'
[[ "$(active_jobs)" == '0' ]] || die 'A job appeared during preflight; refusing worker recreation and POST.'
assert_vm_admission

# Every level begins from a cold worker-local cache. That makes the cache
# behaviour comparable: one fill plus single-flight waits, rather than a warm
# cache accidentally favouring a later level. CPU remains fixed at 2.0.
MEDIA_WORKER_CONCURRENCY="$LEVEL" compose up -d --force-recreate --no-deps media-worker >>"$RUN_DIR/runner.log" 2>&1

for _ in $(seq 1 24); do
  [[ "$(worker_health)" == 'healthy' ]] && break
  sleep 5
done
[[ "$(worker_health)" == 'healthy' ]] || die 'Worker did not become healthy within 120 seconds.'
[[ "$(worker_cpu_limit)" == '2000000000' ]] || die 'Worker CPU cap differs from fixed 2 CPU experiment budget.'
[[ "$(worker_concurrency)" == "$LEVEL" ]] || die 'Worker concurrency did not match requested level.'
assert_vm_admission

docker inspect "$WORKER" --format '{{json .State.Health}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}' >"$RUN_DIR/worker-runtime.json"
docker exec "$WORKER" sh -c 'df -h /tmp; df -i /tmp; du -sh /tmp/media-worker /tmp/media-cache 2>/dev/null || true; cat /sys/fs/cgroup/memory.current; cat /sys/fs/cgroup/memory.max' >"$RUN_DIR/pre-run-capacity.txt"

readonly CLIENT_1="$(uuidgen | tr '[:upper:]' '[:lower:]')"
readonly CLIENT_2="$(uuidgen | tr '[:upper:]' '[:lower:]')"
readonly CLIENT_3="$(uuidgen | tr '[:upper:]' '[:lower:]')"
readonly CLIENT_4="$(uuidgen | tr '[:upper:]' '[:lower:]')"
readonly IDEMPOTENCY_KEY="parallel-cut-${LEVEL}-$(uuidgen | tr '[:upper:]' '[:lower:]')"
printf '%s\n' "$IDEMPOTENCY_KEY" >"$RUN_DIR/idempotency-key.txt"
printf -v PAYLOAD '{"segments":[{"clientSegmentId":"%s","startMs":0,"endMs":1800000},{"clientSegmentId":"%s","startMs":1200000,"endMs":3000000},{"clientSegmentId":"%s","startMs":2400000,"endMs":4200000},{"clientSegmentId":"%s","startMs":3600000,"endMs":5400000}]}' "$CLIENT_1" "$CLIENT_2" "$CLIENT_3" "$CLIENT_4"
printf '%s' "$PAYLOAD" >"$RUN_DIR/request.json"
jq -e '[.segments[].clientSegmentId] | (length == 4 and (unique | length) == 4)' "$RUN_DIR/request.json" >/dev/null \
  || die 'Generated client segment IDs are not four distinct values.'

readonly BEGIN_EPOCH="$(date +%s)"
readonly BEGIN_ISO="$(timestamp)"
printf '%s submit four fixed 30-minute cuts: 00:00-30:00,20:00-50:00,40:00-70:00,60:00-90:00\n' "$BEGIN_ISO" | tee -a "$RUN_DIR/runner.log"
curl --fail --silent --show-error -X POST "$API_BASE_URL/projects/$PROJECT_ID/cuts" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H 'Content-Type: application/json' \
  --data "$PAYLOAD" >"$RUN_DIR/submission.json"
jq -er '.jobs | length == 4' "$RUN_DIR/submission.json" >/dev/null || die 'API did not create exactly four jobs.'
jq -r '.jobs[].id' "$RUN_DIR/submission.json" >"$RUN_DIR/job-ids.txt"

sample() {
  local now cgroup_current cgroup_max tmp_usage cache_usage process_count vm_memory vm_available_kib vm_total_kib
  now="$(timestamp)"
  cgroup_current="$(docker exec "$WORKER" sh -c 'cat /sys/fs/cgroup/memory.current' 2>/dev/null || printf 'unavailable')"
  cgroup_max="$(docker exec "$WORKER" sh -c 'cat /sys/fs/cgroup/memory.max' 2>/dev/null || printf 'unavailable')"
  tmp_usage="$(docker exec "$WORKER" sh -c 'df -B1 /tmp | awk "NR==2 {print \$3 \"/\" \$2}"' 2>/dev/null || printf 'unavailable')"
  cache_usage="$(docker exec "$WORKER" sh -c 'du -sb /tmp/media-cache 2>/dev/null | awk "{print \$1}"' 2>/dev/null || printf '0')"
  process_count="$(docker top "$WORKER" -eo args 2>/dev/null | awk 'NR > 1 && /\/usr\/bin\/ffmpeg/ {n++} END {print n+0}')"
  vm_memory="$(docker exec "$WORKER" sh -c 'awk "/MemTotal:/ {total=\$2} /MemAvailable:/ {available=\$2} END {print available \" \" total}" /proc/meminfo' 2>/dev/null || printf 'unavailable unavailable')"
  read -r vm_available_kib vm_total_kib <<<"$vm_memory"
  printf '%s\tcgroup_bytes=%s/%s\tvm_available_kib=%s/%s\ttmpfs_bytes=%s\tcache_bytes=%s\tffmpeg_processes=%s\n' \
    "$now" "$cgroup_current" "$cgroup_max" "$vm_available_kib" "$vm_total_kib" "$tmp_usage" "$cache_usage" "$process_count" >>"$RUN_DIR/runtime-samples.tsv"
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}' \
    | sed "s/^/$now\\t/" >>"$RUN_DIR/docker-stats.tsv"
  docker top "$WORKER" -eo pid,etime,pcpu,pmem,args >>"$RUN_DIR/process-samples.txt" 2>/dev/null || true
}

status_snapshot() {
  curl --fail --silent --show-error "$API_BASE_URL/projects/$PROJECT_ID/pipeline-jobs" >"$RUN_DIR/latest-jobs.json"
  jq --argjson ids "$(jq -Rsc 'split("\n") | map(select(length > 0))' "$RUN_DIR/job-ids.txt")" \
    '[.items[] | select(.id as $id | $ids | index($id))] | {states: (group_by(.state) | map({state: .[0].state, count: length})), jobs: .}' \
    "$RUN_DIR/latest-jobs.json" >"$RUN_DIR/status-latest.json"
}

is_done() {
  jq -e '[.jobs[].state] | length == 4 and all(.[]; . == "READY" or . == "FAILED_FINAL")' "$RUN_DIR/status-latest.json" >/dev/null
}

while :; do
  sample
  status_snapshot
  if is_done; then break; fi
  now_epoch="$(date +%s)"
  (( now_epoch - BEGIN_EPOCH < MAX_LEVEL_SECONDS )) || die "Level exceeded ${MAX_LEVEL_SECONDS}s deadline."
  # memory.max can legitimately be `max` because Docker Desktop limits the VM,
  # not this container. `/proc/meminfo` reports that VM-wide budget, including
  # tmpfs pages and every Compose service, so gate on available VM memory.
  vm_current="$(tail -n 1 "$RUN_DIR/runtime-samples.tsv" | sed -n 's/.*vm_available_kib=\([0-9]*\)\/\([0-9]*\).*/\1 \2/p')"
  if [[ "$vm_current" =~ ^([0-9]+)[[:space:]]+([0-9]+)$ ]] && (( BASH_REMATCH[2] > 0 )); then
    vm_available_mib=$(( BASH_REMATCH[1] / 1024 ))
    vm_available_percent=$(( BASH_REMATCH[1] * 100 / BASH_REMATCH[2] ))
    if (( vm_available_mib < VM_AVAILABLE_STOP_MIB || vm_available_percent < VM_AVAILABLE_STOP_PERCENT )); then
      die "VM memory safety stop: only ${vm_available_mib} MiB (${vm_available_percent}%) available; active jobs are left untouched and no later level may start."
    fi
  else
    die 'VM memory telemetry became unavailable after POST; active jobs are left untouched and no later level may start.'
  fi
  sleep "$SAMPLE_INTERVAL_SECONDS"
done

readonly END_ISO="$(timestamp)"
printf '%s level=%s terminal state reached\n' "$END_ISO" "$LEVEL" | tee -a "$RUN_DIR/runner.log"
status_snapshot
cp "$RUN_DIR/status-latest.json" "$RUN_DIR/final-jobs.json"
docker logs --since "$BEGIN_ISO" "$WORKER" >"$RUN_DIR/worker-structured.log" 2>&1 || true

JOB_ID_SQL="$(sed "s/^/'/;s/$/'/" "$RUN_DIR/job-ids.txt" | paste -sd, -)"
docker exec content-factory-postgres-1 psql --csv -U content_factory -d content_factory \
  -c "SELECT p.id, p.state, p.\"recipeVersion\", p.\"queuedAt\", p.\"startedAt\", p.\"finishedAt\", round(extract(epoch FROM (p.\"startedAt\" - p.\"queuedAt\")) * 1000) AS queue_wait_ms, round(extract(epoch FROM (p.\"finishedAt\" - p.\"startedAt\")) * 1000) AS run_ms, a.\"attemptNumber\", a.state AS attempt_state, a.\"workerId\", a.\"failureCode\", m.\"sizeBytes\", m.sha256, m.\"ffmpegVersion\" FROM \"PipelineJob\" p LEFT JOIN \"JobAttempt\" a ON a.\"jobId\" = p.id LEFT JOIN \"MediaArtifact\" m ON m.\"pipelineJobId\" = p.id WHERE p.id IN ($JOB_ID_SQL) ORDER BY p.\"queuedAt\", p.id;" >"$RUN_DIR/job-timings.csv"

while IFS= read -r job_id; do
  # Fast-start MP4 metadata lets ffprobe finish before a complete HTTP stream.
  # curl then correctly returns 23 (downstream closed pipe); accept only that
  # specific transport outcome with a successful probe, and separately drain
  # the complete API response below.
  set +e
  curl --fail --silent --show-error "$API_BASE_URL/pipeline-jobs/$job_id/result" \
    | docker exec -i "$WORKER" /usr/bin/ffprobe -v error -show_entries 'format=duration:stream=codec_name,codec_type' -of json -i pipe:0 \
    >"$RUN_DIR/$job_id.ffprobe.json"
  probe_statuses=("${PIPESTATUS[@]}")
  set -e
  [[ "${probe_statuses[1]}" == '0' && ( "${probe_statuses[0]}" == '0' || "${probe_statuses[0]}" == '23' ) ]] \
    || die "FFprobe stream failed for $job_id (curl=${probe_statuses[0]}, ffprobe=${probe_statuses[1]})."
  jq -e '(.format.duration | tonumber) >= 1799.8 and (.format.duration | tonumber) <= 1800.2 and ([.streams[] | select(.codec_type == "video") | .codec_name] | index("h264")) and ([.streams[] | select(.codec_type == "audio") | .codec_name] | index("aac"))' \
    "$RUN_DIR/$job_id.ffprobe.json" >/dev/null || die "FFprobe validation failed for $job_id."
  curl --fail --silent --show-error --dump-header "$RUN_DIR/$job_id.result-headers.txt" --output /dev/null \
    "$API_BASE_URL/pipeline-jobs/$job_id/result"
done <"$RUN_DIR/job-ids.txt"

docker exec "$WORKER" sh -c 'df -h /tmp; df -i /tmp; du -sh /tmp/media-worker /tmp/media-cache 2>/dev/null || true; cat /sys/fs/cgroup/memory.current; cat /sys/fs/cgroup/memory.max' >"$RUN_DIR/post-run-capacity.txt"
restore_baseline_after_drain
printf '%s complete run_dir=%s\n' "$(timestamp)" "$RUN_DIR" | tee -a "$RUN_DIR/runner.log"
