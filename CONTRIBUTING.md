# Contributing Guide

## Before coding

1. Classify the work: API, MCP, browser plugin, shared library, or infrastructure.
2. Confirm the boundary contract that changes.
3. Choose the extension point rather than modifying core orchestration.
4. Capture POC behavior as tests if the work is based on POC code.

## PR expectations

Each production PR should include:

- A short design note or linked ADR when architecture changes.
- Contract updates: OpenAPI, MCP capability spec, or extension message schema.
- Tests for happy path, failure path, invalid input, auth/permission failure, timeout/cancellation where relevant.
- Observability fields and example logs for new operations.
- Security notes for data access, permissions, secrets, authz, and user consent.

### Multi-sub-task stage PRs (Codex + lead collaboration)

For PRs that ship a multi-sub-task stage through the Codex-and-lead
collaboration model — e.g., the Stage 1 MVP (PR #99), Stage 2/3 work graph
(PR #105), and any future Stage N+ PRs — use the template at
[`docs/templates/codex-lead-stage-pr.md`](docs/templates/codex-lead-stage-pr.md).

The template carries both the PR-body skeleton (Wave structure, Codex-pull
checklist, test plan) AND the operational protocol (poll-before-write,
`/tmp` staging for context-saving, push-then-mark, lead integration
cadence, status-comment shape). Adopt as-is for new stage PRs; clone +
adjust for sub-task counts and waves.

## Code review rubric

Review by asking:

- Can a future feature be added by registering a new implementation instead of editing this module?
- Is every external input parsed into a typed model before use?
- Is error behavior predictable and consistent?
- Is the feature observable enough to debug in production?
- Does the component request only the privileges it needs?
- Is the implementation simpler than the abstraction it introduces?

## POC handling

POCs are valuable for learning and should not be shamed for quality. In product code, reference them as behavior evidence only. Do not preserve POC shortcuts such as global mutable state, broad permissions, mock security, unbounded retries, missing schema validation, and console-only debugging.
