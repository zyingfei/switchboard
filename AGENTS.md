# AGENTS.md — Switchboard / browser-ai-companion

This file is the universal coding-agent guidance for this repository
(per the Linux Foundation Agentic AI standard). All agents — Claude
Code, Cursor, Codex CLI, JetBrains, custom — should read this before
making changes.

## What this repo is

Switchboard is a local-first browser AI companion: a Chrome MV3
extension + Node companion process + stateless MCP reader that helps a
user track active AI work across providers (ChatGPT / Claude / Gemini /
coding agents), reorganize it manually, queue follow-ups, recover lost
tabs, and generate portable packets for other AIs and notebooks.

Core product context:

- **Brainstorm**: [`BRAINSTORM.md`](BRAINSTORM.md) — the exhaustive
  product surface. ~2800 lines. Use [`BRAINSTORM-INDEX.md`](BRAINSTORM-INDEX.md)
  to navigate. **Architectural anchors live here** (§23.0, §24.5,
  §24.10, §27, §27.6, §28). Do not contradict these without an
  explicit user override.
- **PRD (in flight)**: see PR #11 on `prd/switchboard-mvp-v1` for the
  v1 MVP scope. The PRD references the brainstorm anchors by section
  number.
- **PoC code**: under [`poc/`](poc/) — five PoCs validated specific
  unknowns. Treat as evidence, not as production code. Per
  [`CODING_STANDARDS.md`](CODING_STANDARDS.md) §"POC-to-product
  conversion rule," capture useful PoC behavior as tests before
  promoting any of it to product.

## Engineering standards (load-bearing)

These standards govern all production code. They apply per component
(API / MCP / browser plugin) plus a shared engineering baseline.

| Document | When it applies |
|---|---|
| [`CODING_STANDARDS.md`](CODING_STANDARDS.md) | All production code. Read first. Non-negotiables, code-quality gates, preferred architecture (ports & adapters), POC-to-product conversion rule. |
| [`standards/00-engineering-baseline.md`](standards/00-engineering-baseline.md) | All components. Boundary validation, typed errors, observability, security baseline. |
| [`standards/01-api-component.md`](standards/01-api-component.md) | Any HTTP API surface (companion's localhost API, future external endpoints). Contract-first OpenAPI, resource-oriented design, error shape, idempotency, pagination, authz. |
| [`standards/02-mcp-components.md`](standards/02-mcp-components.md) | MCP server (`bac-mcp` reader), any MCP host work, any MCP tool/resource/prompt the companion exposes. Capability registry, lifecycle, safety, consent, transport. |
| [`standards/03-ts-browser-plugin.md`](standards/03-ts-browser-plugin.md) | The Chrome MV3 extension. Service-worker lifecycle, typed message bus, content-script isolation, permission minimization, storage migrations. |

Per-feature documentation requirement (from `CODING_STANDARDS.md` §"Documentation required per feature"):

- Boundary contract (OpenAPI path, MCP capability spec, or extension message contract)
- Security impact (data, permissions, authz, consent)
- Failure behavior (retry, timeout, cancellation, fallback, error shape)
- Observability (span names, log fields, metric names)
- Extension model (where future variants plug in without modifying core)

## Pre-merge checklists

Use these in PR descriptions until CI enforcement catches up:

- [`checklists/production-readiness.md`](checklists/production-readiness.md) — every production PR
- [`checklists/api-design-review.md`](checklists/api-design-review.md) — any HTTP surface change
- [`checklists/mcp-design-review.md`](checklists/mcp-design-review.md) — any MCP capability change
- [`checklists/browser-plugin-design-review.md`](checklists/browser-plugin-design-review.md) — any extension change

## Templates

Use these when authoring new boundary contracts:

- [`templates/api-endpoint-rfc.md`](templates/api-endpoint-rfc.md) — new HTTP endpoint
- [`templates/mcp-capability-spec.md`](templates/mcp-capability-spec.md) — new MCP tool / resource / prompt
- [`templates/extension-message-contract.md`](templates/extension-message-contract.md) — new cross-context extension message
- [`templates/adr.md`](templates/adr.md) — architectural decision record

## Configs to wire into packages

When scaffolding a new TypeScript package under `poc/` or eventually
under `packages/`, extend the shared configs:

- [`configs/ts/tsconfig.base.json`](configs/ts/tsconfig.base.json) — strict TS settings
- [`configs/ts/eslint.config.mjs`](configs/ts/eslint.config.mjs) — typed linting
- [`configs/ts/prettier.config.mjs`](configs/ts/prettier.config.mjs) — formatter
- [`configs/ts/vitest.config.ts`](configs/ts/vitest.config.ts) — test runner
- [`configs/ts/package.scripts.example.json`](configs/ts/package.scripts.example.json) — `lint` / `typecheck` / `test` scripts
- [`configs/openapi/openapi.base.yaml`](configs/openapi/openapi.base.yaml) + [`configs/openapi/api-style-rules.yaml`](configs/openapi/api-style-rules.yaml) — for any HTTP API

The verify script at [`scripts/verify-standards.sh`](scripts/verify-standards.sh) runs the kit's basic checks; wire it into CI.

## Repo conventions

These are Switchboard-specific and override anything generic in the
standards above:

- **`_BAC/` reserved namespace** in the user's vault. All Switchboard-
  owned files live under it; never write outside `_BAC/` without
  explicit user action. Per BRAINSTORM §23.0 + §27.
- **Stable IDs (`bac_id`)** are identity; file paths are projections.
  Renames and moves never break references. Per BRAINSTORM §26.5.1
  invariant.
- **Vault is canonical state.** The Node companion writes; the
  extension is sensor + UI; `bac-mcp` is read-only. Per BRAINSTORM
  §27.6.
- **Substrate is filesystem + Markdown + frontmatter + `.canvas` +
  `.base`.** Plugins (incl. Local REST API) are opt-in acceleration,
  never required. Per BRAINSTORM §23.0.
- **§24.10 safety primitives are ship-blocking**: RedactionPipeline,
  token-budget warnings, screen-share-safe mode, captured-page
  injection scrub. Apply at every dispatch boundary.
- **§28 inline review** is a distinct primitive (annotation on
  assistant turns), not a packet. Don't conflate.
- **PoC TODO → README convention**: each `poc/<name>/` either has a
  `TODO.md` (planning, gets deleted on completion) or a `README.md`
  (post-build doc). Never both — when work is done, delete TODO and
  write README.
- **PoC code is dumpable.** Per `CODING_STANDARDS.md` §"POC-to-product
  conversion rule," do not blindly promote PoC code to production —
  capture behavior as tests, design the production boundary, implement
  through the standard architecture.

## Working with Codex / Claude Code / Cursor on this repo

If you are an AI agent picking up work here:

1. Read [`BRAINSTORM.md`](BRAINSTORM.md) §23.0, §24.5, §24.10, §27,
   §27.6, §28 for the locked architectural anchors.
2. Read the relevant component standard from `standards/`.
3. Read the PoC's existing `README.md` (if it has one) for evidence of
   what was tried.
4. Use [`templates/`](templates/) when authoring new boundary
   contracts.
5. Run [`checklists/production-readiness.md`](checklists/production-readiness.md)
   before declaring done.
6. Per `CODING_STANDARDS.md`: validate every boundary input as
   `unknown` until parsed; never use `any`; no hidden global state;
   observability is part of the feature.

If a Switchboard convention conflicts with the generic kit standards,
the convention wins (this file is the override surface).

## Deviations / open issues

- Some `poc/` folders still hold `TODO.md` from earlier planning;
  those should be deleted as the post-build READMEs land. See PoC
  folder READMEs for canonical state.
- The kit's `INSTALL.md` describes adoption from a fresh repo; it's
  kept for reference but the kit is already integrated here. New
  packages should follow [`INSTALL.md`](INSTALL.md) §"Wire TypeScript
  packages" / §"Wire API contracts" / §"Wire MCP standards."
