#!/usr/bin/env bash
set -euo pipefail

# Build a heading + scenario/edge/risk index of BRAINSTORM.md.
# Skips headings inside fenced code blocks and only catches S/E/R markers
# that appear in the canonical table-row form: "| **X##** | ..." or "| X## |".
#
# Usage:
#   scripts/build-brainstorm-index.sh                   # writes BRAINSTORM-INDEX.md
#   scripts/build-brainstorm-index.sh --stdout          # prints to stdout
#   scripts/build-brainstorm-index.sh path/to/doc.md    # alternate source

OUT_TO_STDOUT=0
SRC=""
for arg in "$@"; do
  case "$arg" in
    --stdout) OUT_TO_STDOUT=1 ;;
    *)        SRC="$arg" ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SRC:-$REPO_ROOT/BRAINSTORM.md}"
OUT="${REPO_ROOT}/BRAINSTORM-INDEX.md"

[[ -f "$SRC" ]] || { echo "not found: $SRC" >&2; exit 1; }

LINES=$(wc -l < "$SRC" | tr -d ' ')
NOW=$(date +%Y-%m-%d)

emit_headings() {
  awk '
    /^```/                    { in_code = !in_code; next }
    in_code                   { next }
    /^## /                    { sub(/^## /, "");   printf "- L%d — %s\n",         NR, $0 }
    /^### /                   { sub(/^### /, "");  printf "    - L%d — %s\n",     NR, $0 }
    /^#### /                  { sub(/^#### /, ""); printf "        - L%d — %s\n", NR, $0 }
  ' "$SRC"
}

# Match table-row markers in either bold or plain form:
#   | **S25** | ...
#   | S25 | ...
# $1 = letter (S|E|R)
emit_markers() {
  local letter="$1"
  awk -v L="$letter" '
    /^```/         { in_code = !in_code; next }
    in_code        { next }
    {
      pat = "^\\| (\\*\\*)?" L "[0-9]+(\\*\\*)? \\|"
      if ($0 ~ pat) {
        copy = $0
        sub(/^\| (\*\*)?/, "", copy)
        match(copy, "^" L "[0-9]+")
        id = substr(copy, RSTART, RLENGTH)
        if (!(id in seen) || seen[id] > NR) seen[id] = NR
      }
    }
    END {
      n = 0
      for (k in seen) keys[++n] = k
      # numeric sort by trailing digits
      for (i = 1; i <= n; i++) {
        for (j = i+1; j <= n; j++) {
          a = substr(keys[i], 2) + 0
          b = substr(keys[j], 2) + 0
          if (a > b) { t = keys[i]; keys[i] = keys[j]; keys[j] = t }
        }
      }
      for (i = 1; i <= n; i++) printf "- L%d — %s\n", seen[keys[i]], keys[i]
    }
  ' "$SRC"
}

emit() {
  cat <<EOF
# BRAINSTORM index

Generated $NOW. Source: \`$(basename "$SRC")\` ($LINES lines).
Built by \`scripts/build-brainstorm-index.sh\` — re-run after edits.

## Headings

EOF
  emit_headings
  echo
  echo "## Scenarios (S###)"
  echo
  emit_markers S
  echo
  echo "## Edge cases (E##)"
  echo
  emit_markers E
  echo
  echo "## Risks (R##)"
  echo
  emit_markers R
}

if [[ "$OUT_TO_STDOUT" == "1" ]]; then
  emit
else
  emit > "$OUT"
  echo "wrote $OUT ($(wc -l < "$OUT" | tr -d ' ') lines)"
fi
