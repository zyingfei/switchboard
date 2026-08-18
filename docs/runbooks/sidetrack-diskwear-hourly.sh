#!/bin/bash
# Hourly disk-wear telemetry — launchd: com.sidetrack.diskwear (StartInterval
# 3600; created 2026-08-16). Repo copy: docs/runbooks/; live copy:
# ~/.sidetrack-diskwear-hourly.sh (sync at deploy time, same convention as
# sidetrack-companion-maintenance.sh).
#
# WHY (measured, not guessed): SMART showed +410GB host writes in one day;
# the copy-on-publish generation write amplification (437MB db duplicated
# per drain publish, task #28) was found only by MANUAL smartctl deltas a
# day later. Nightly cadence was rejected as too slow — this runs HOURLY
# and is FULLY DETERMINISTIC (binding user rule 2026-08-16: no LLM inside
# cron jobs; a coordinator/human analyzes the JSONL when reviewing):
#   1. capture SMART lifetime counters + sidetrack dir sizes -> bounded JSONL
#   2. compute written-bytes deltas (1h and trailing-6h) in-place
#   3. macOS notification the moment a threshold breaches
# Every step best-effort: telemetry must never wedge or spam.
#
# Thresholds: machine-wide SMART counts everything (browsers, builds), so
# the alarm uses generous slack — >4GB written in one hour OR >12GB across
# the trailing 6 entries. Attribution lives in the captured vault/conn dir
# sizes: growth or churn there alongside a breach points at Sidetrack.

LOG="$HOME/.sidetrack-diskwear.jsonl"
REPORT="$HOME/.sidetrack-diskwear-report.txt"
RETAIN=2000
HOURLY_ALERT_BYTES=$((4 * 1024 * 1024 * 1024))
SIXHOUR_ALERT_BYTES=$((12 * 1024 * 1024 * 1024))
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

command -v rtk >/dev/null 2>&1 || exit 0
# smartctl exit codes are a status BITMASK — non-zero even on healthy reads
# (observed code=745 with full output). Gate on output presence, not rc.
SMART_JSON="$(rtk smartctl -j -a /dev/disk0 2>/dev/null || true)"
case "$SMART_JSON" in *nvme_smart_health_information_log*) ;; *) exit 0 ;; esac
export SMART_JSON

BREACH="$(python3 - "$LOG" "$REPORT" "$RETAIN" "$HOURLY_ALERT_BYTES" "$SIXHOUR_ALERT_BYTES" <<'PYEOF'
import json, os, subprocess, sys, time
log_path, report_path, retain, hourly_alert, sixhour_alert = (
    sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]),
    int(sys.argv[5]))
smart = json.loads(os.environ["SMART_JSON"])
nvme = smart.get("nvme_smart_health_information_log", {})

def du_bytes(path):
    try:
        out = subprocess.run(["du", "-sk", path], capture_output=True,
                             text=True, timeout=120)
        return int(out.stdout.split()[0]) * 1024
    except Exception:
        return None

home = os.path.expanduser("~")
entry = {
    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    # NVMe data units are 1000 * 512 bytes each.
    "written": (nvme.get("data_units_written") or 0) * 512000,
    "read": (nvme.get("data_units_read") or 0) * 512000,
    "wear_pct": nvme.get("percentage_used"),
    "vault": du_bytes(f"{home}/.sidetrack-vault"),
    "vault_test": du_bytes(f"{home}/.sidetrack-vault-test"),
    "conn": du_bytes(f"{home}/.sidetrack-vault/_BAC/connections"),
    "conn_test": du_bytes(f"{home}/.sidetrack-vault-test/_BAC/connections"),
}
# Per-process kernel disk-IO counters (proc_pid_rusage, no root needed) —
# the ONLY honest per-process write measure: du deltas miss in-place WAL
# churn entirely (2026-08-17 user-methodology correction). Counters are
# per-pid lifetime; a pid change means restart — record pid so readers
# treat the first post-restart delta as a reset, not a negative.
for name, port in (("proc_test", 17374), ("proc_daily", 17373)):
    try:
        pid = int(subprocess.run(["lsof", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                                 capture_output=True, text=True, timeout=20).stdout.split()[0])
        r = subprocess.run(["bun", "-e", (
            "import{dlopen,FFIType,ptr}from'bun:ffi';"
            "const l=dlopen('/usr/lib/libproc.dylib',{proc_pid_rusage:{args:[FFIType.i32,FFIType.i32,FFIType.ptr],returns:FFIType.i32}});"
            "const b=new BigUint64Array(64);"
            f"if(l.symbols.proc_pid_rusage({pid},4,ptr(b))===0)process.stdout.write(String(Number(b[18]))+' '+String(Number(b[19])));"
        )], capture_output=True, text=True, timeout=30,
            env={**os.environ, "PATH": os.path.expanduser("~/.bun/bin") + ":" + os.environ.get("PATH", "")})
        parts = r.stdout.split()
        if len(parts) == 2:
            entry[f"{name}_pid"] = pid
            entry[f"{name}_read"] = int(parts[0])
            entry[f"{name}_written"] = int(parts[1])
    except Exception:
        pass

lines = []
if os.path.exists(log_path):
    with open(log_path) as f:
        lines = [l for l in f.read().splitlines() if l.strip()]
prev = json.loads(lines[-1]) if lines else None

# Deterministic deltas stored ON the entry so any later reader (human or
# coordinating agent) sees rates without recomputing.
if prev and isinstance(prev.get("written"), int):
    entry["written_delta_1h"] = entry["written"] - prev["written"]
    for k in ("vault", "vault_test", "conn", "conn_test"):
        if isinstance(prev.get(k), int) and isinstance(entry.get(k), int):
            entry[f"{k}_delta_1h"] = entry[k] - prev[k]

lines.append(json.dumps(entry, separators=(",", ":")))
with open(log_path + ".tmp", "w") as f:
    f.write("\n".join(lines[-retain:]) + "\n")
os.replace(log_path + ".tmp", log_path)

breach = ""
d1 = entry.get("written_delta_1h")
elapsed_s = None
if prev:
    try:
        from datetime import datetime
        fmt = "%Y-%m-%dT%H:%M:%SZ"
        elapsed_s = (datetime.strptime(entry["ts"], fmt)
                     - datetime.strptime(prev["ts"], fmt)).total_seconds()
    except Exception:
        elapsed_s = None
# Rate-normalized: compare bytes/hour, and only after >=30min elapsed so a
# RunAtLoad capture minutes after the previous one cannot fake an hourly
# number (root cause of the first confusing alarm). NOTE: no apostrophes or
# double quotes in comments here — macOS bash 3.2 mis-lexes quote chars
# inside a heredoc nested in command substitution.
if (isinstance(d1, int) and elapsed_s and elapsed_s >= 1800
        and d1 * 3600 / elapsed_s > hourly_alert):
    breach = f"{d1/1e9:.1f}GB in {elapsed_s/60:.0f}min (rate > {hourly_alert/1e9:.0f}GB/h)"
window = [json.loads(l) for l in lines[-7:]]
if not breach and len(window) >= 2:
    span = window[-1]["written"] - window[0]["written"]
    if span > sixhour_alert:
        breach = f"trailing-6h {span/1e9:.1f}GB > {sixhour_alert/1e9:.0f}GB"

if breach:
    st_delta = sum(entry.get(f"{k}_delta_1h") or 0 for k in ("vault", "vault_test"))
    breach = f"machine {breach}; sidetrack dirs {st_delta/1e6:+.0f}MB"
    attribution = ", ".join(
        f"{k}={entry[f'{k}_delta_1h']/1e6:+.0f}MB"
        for k in ("vault", "vault_test", "conn", "conn_test")
        if isinstance(entry.get(f"{k}_delta_1h"), int))
    with open(report_path, "a") as f:
        f.write(f"=== {entry['ts']} BREACH {breach}; sidetrack dirs 1h: "
                f"{attribution or 'n/a'}\n")
    try:
        with open(report_path) as f:
            rlines = f.read().splitlines()
        with open(report_path + ".tmp", "w") as f:
            f.write("\n".join(rlines[-300:]) + "\n")
        os.replace(report_path + ".tmp", report_path)
    except Exception:
        pass
    print(breach)
PYEOF
)"

if [ -n "$BREACH" ]; then
  osascript -e "display notification \"$BREACH — see ~/.sidetrack-diskwear-report.txt\" with title \"Sidetrack disk wear\"" >/dev/null 2>&1 || true
fi
