# Calibrated lane-to-fusion promotion

Status: implemented, evidence-gated

Sidetrack may count agreement from the query-time `content` and `ai`
lanes as one additional corroborating source only when both lanes agree
with fusion's existing top workstream and each lane has measured
precision at least `0.60` over at least `20` joined outcomes. The
promotion re-runs the existing attribution policy and is capped at
`suggest`; it cannot re-rank candidates or auto-file a page.

## Boundary contract

This feature adds no HTTP or extension-message field. It consumes the
existing lane-prequential summary and changes only the served decision
copy. `SIDETRACK_LANE_CORROBORATION=0` (or `false`) is the immediate
kill switch. With the variable unset, the mechanism is armed but remains
a no-op until the measurement gate is earned.

## Safety and failure behavior

- Missing, disabled, stale, below-threshold, or undersampled measurement
  fails closed to the incumbent decision.
- A recorded `Not in any stream` decline vetoes promotion.
- Lane disagreement, disagreement with fusion, or any binding gate other
  than corroboration leaves the result unchanged.
- The strongest possible result is a visible suggestion. The user still
  decides whether to file it.
- All inputs and outputs remain local to the companion; no page content or
  prediction record is sent off-device.

## Observability and referee

Promoted decisions include the marker `lane-corroborated` plus the
binding precision and sample count in the gate detail. The underlying
per-lane counts remain visible in the system-health lane-calibration
section.

`bun run test:golden` is a named blocking CI referee. It freezes the live
failure classes (hub magnet, corroboration hold, lane-only fallback, and
decline memory) and the golden-set scoring contract. A serving-policy
change must keep that referee green before the broad companion suite is
considered.

## Extension model

Future query-time lanes plug in through the calibrated lane list and
evidence fold in `laneCorroboration.ts`. Admission requires a prequential identity and
outcome join, an explicit precision/sample threshold, a golden failure
case, and a declared maximum action. Adding a lane without those four
pieces cannot change a served decision.
