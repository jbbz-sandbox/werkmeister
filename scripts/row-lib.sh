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
