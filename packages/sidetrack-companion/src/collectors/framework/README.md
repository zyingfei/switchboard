Capability gates are collector-framework checks that decide whether a declared sensitive capability may run.
Each gate maps to existing `privacy.permission.granted` and `privacy.permission.revoked` projection entries.
Permission keys use `collector.<collector-id>.<capability>`, with one key per collector capability.
The module reuses existing privacy events so the event registry and privacy UI do not need new event types.
`GateState` is `granted` when allowed, `revoked` when explicitly denied, and `pending` when default-disabled with no decision.
