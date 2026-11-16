# Shared by measure-row.sh and ab-row.sh (SW-790); sourced, not run. POSIX sh + awk.
# Load is read from /proc/stat, which in a container is the whole Docker VM's: every
# workspace's work shows there, and unlike the 1-min loadavg it doesn't lag behind our own last run.
# The Mac's uptime never sees the VM (SW-556).

# <stat line 1> <stat line 2>: busy cores over the interval; NCPU is the VM's CPU count.
busy_between() {
  printf '%s\n%s\n' "$1" "$2" | awk -v n="${NCPU:?}" '
    { t = 0; for (i = 2; i <= 9; i++) t += $i; tot[NR] = t; idle[NR] = $5 + $6 }
    END { dt = tot[2] - tot[1]; printf "%.1f\n", (dt > 0 ? (dt - (idle[2] - idle[1])) / dt * n : 0) }'
}

# ROW_BUSY fakes the reading, so a test can stand in for load instead of burning CPU.
busy_cores() {
  if [ -n "${ROW_BUSY:-}" ]; then echo "$ROW_BUSY"; return; fi
  a=$(head -1 /proc/stat)
  sleep 10
  NCPU=$(grep -c '^cpu[0-9]' /proc/stat) busy_between "$a" "$(head -1 /proc/stat)"
}

# Busy (not idle, not iowait) microseconds of the whole VM since boot.
vm_cpu_usec() {
  head -1 /proc/stat | awk -v hz="$(getconf CLK_TCK)" '
    { t = 0; for (i = 2; i <= 9; i++) t += $i; printf "%.0f\n", (t - $5 - $6) * 1e6 / hz }'
}

gt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a > b) }'; }

# <script name>: resolves $ws and $out to real paths; exits 2 when -o is outside -w, or -w isn't
# this container's workspace. The container mounts every workspace and the real ~/.werkmeister.
own_out() {
  ws=$(cd "$ws" 2>/dev/null && pwd -P) || { echo "$1: -w is not a folder" >&2; exit 2; }
  o_dir=$(cd "$(dirname "$out")" 2>/dev/null && pwd -P) || { echo "$1: -o: no folder $(dirname "$out")" >&2; exit 2; }
  out=$o_dir/$(basename "$out")
  case $out/ in "$ws"/*) ;; *) echo "$1: -o $out is outside $ws" >&2; exit 2 ;; esac
  o_feature=$(awk '$1 == "feature:" { print $2; exit }' "$ws/.werkmeister/workspace.yml" 2>/dev/null)
  [ -z "${WERKMEISTER_FEATURE:-}" ] || [ "$o_feature" = "$WERKMEISTER_FEATURE" ] ||
    { echo "$1: -w $ws is feature '$o_feature', this container's is '$WERKMEISTER_FEATURE'" >&2; exit 2; }
}

# This container's CPU microseconds; ROW_CGROUP_STAT points a test at a fake file.
cgroup_usec() { awk '/^usage_usec/ { print $2 }' "${ROW_CGROUP_STAT:-/sys/fs/cgroup/cpu.stat}"; }

# <suite> <file> <log> <cmd...>: runs cmd into log, prints "suite file rc wall_s cpu_s others_s" (tabs).
# Always returns 0, so a per-file loop goes on past a failing file; rc is in the row.
measure_one() {
  m_suite=$1 m_file=$2 m_log=$3
  shift 3
  m_c0=$(cgroup_usec) m_v0=$(vm_cpu_usec) m_t0=$(date +%s.%N)
  "$@" >"$m_log" 2>&1
  m_rc=$?
  m_t1=$(date +%s.%N) m_c1=$(cgroup_usec) m_v1=$(vm_cpu_usec)
  awk -v s="$m_suite" -v f="$m_file" -v rc="$m_rc" -v t0="$m_t0" -v t1="$m_t1" \
    -v c0="$m_c0" -v c1="$m_c1" -v v0="$m_v0" -v v1="$m_v1" 'BEGIN {
    printf "%s\t%s\t%d\t%.1f\t%.1f\t%.1f\n", s, f, rc, t1 - t0, (c1 - c0) / 1e6, ((v1 - v0) - (c1 - c0)) / 1e6 }'
}

# Waits while the VM is busier than ROW_LOAD_LIMIT cores, up to ROW_LOAD_WAIT s (0: check once);
# returns 75 (with-temp-home's "load still over") when the wait runs out. Sets busy_before, waited_s.
wait_quiet() {
  limit=${ROW_LOAD_LIMIT:-1.0}
  max=${ROW_LOAD_WAIT:-600}
  waited_s=0
  busy_before=$(busy_cores)
  gt "$busy_before" "$limit" || return 0
  echo "row: waiting up to $max s for VM busy $busy_before cores to fall to $limit (ROW_LOAD_LIMIT)" >&2
  start=$(date +%s)
  said=0
  while [ "$waited_s" -lt "$max" ]; do
    sleep 5
    busy_before=$(busy_cores)
    waited_s=$(($(date +%s) - start))
    gt "$busy_before" "$limit" || return 0
    [ $((waited_s - said)) -lt 60 ] || {
      said=$waited_s
      echo "row: still waiting: busy $busy_before, $waited_s s so far" >&2
    }
  done
  echo "row: VM still busy $busy_before cores after $waited_s s; not measuring. Retry later or raise ROW_LOAD_LIMIT." >&2
  return 75
}

# <log>: sums node:test (spec and TAP) and vitest summary lines under any turbo prefix.
test_counts() {
  awk '
    { gsub(/\033\[[0-9;]*m/, "") }
    match($0, /(ℹ|#) (tests|pass|fail) [0-9]+$/) {
      split(substr($0, RSTART), w, " ")
      if (w[2] == "tests") t += w[3]; else if (w[2] == "pass") p += w[3]; else f += w[3]
      next
    }
    /Tests +[0-9]/ && !/Test Files/ {
      s = $0; sub(/.*Tests +/, "", s)
      n = s; sub(/.*\(/, "", n); t += n + 0
      if (match(s, /[0-9]+ passed/)) p += substr(s, RSTART, RLENGTH) + 0
      if (match(s, /[0-9]+ failed/)) f += substr(s, RSTART, RLENGTH) + 0
    }
    END { printf "tests %d pass %d fail %d\n", t, p, f }' "$1"
}

# Numbers on stdin: the median, the mean of the middle two for an even count.
median() {
  sort -n | awk '{ a[NR] = $1 } END { if (NR) printf "%.1f\n", NR % 2 ? a[(NR + 1) / 2] : (a[NR / 2] + a[NR / 2 + 1]) / 2 }'
}
