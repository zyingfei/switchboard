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
if isinstance(d1, int) and d1 > hourly_alert:
    breach = f"hourly {d1/1e9:.1f}GB > {hourly_alert/1e9:.0f}GB"
window = [json.loads(l) for l in lines[-7:]]
if not breach and len(window) >= 2:
    span = window[-1]["written"] - window[0]["written"]
    if span > sixhour_alert:
        breach = f"trailing-6h {span/1e9:.1f}GB > {sixhour_alert/1e9:.0f}GB"

if breach:
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
