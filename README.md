# Sidetrack

A local-first side panel that keeps your active AI work from scattering across tabs, providers, searches, and coding sessions.

Sidetrack tracks the AI threads you have open across ChatGPT, Claude, and Gemini and lets you organize them into workstreams as the shape of the work becomes clear — not up front. Everything stays in your own vault on disk, and a small read-only MCP server makes that work reachable to coding agents.

## Status

Mid-build. The architecture and product surface are settled (see [`PRD.md`](PRD.md) and [`BRAINSTORM.md`](BRAINSTORM.md)); proofs-of-concept under [`poc/`](poc) validate the substrate; production code is landing under `packages/*` through the milestones in [`docs/milestones/`](docs/milestones). The GitHub repo is [`zyingfei/switchboard`](https://github.com/zyingfei/switchboard) for backward compatibility — the product name is Sidetrack.

## Start here

- **What it does and why** — [`PRD.md`](PRD.md)
- **Full product surface and locked anchors** — [`BRAINSTORM.md`](BRAINSTORM.md) (with [`BRAINSTORM-INDEX.md`](BRAINSTORM-INDEX.md))
- **Architectural decisions** — [`docs/adr/`](docs/adr)
- **Working in this repo** — [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Engineering bar** — [`CODING_STANDARDS.md`](CODING_STANDARDS.md) and [`standards/`](standards)

## Try it

Prerequisites: Node 22+ and Chrome 147+. The most useful runnable entry point today is [`poc/local-bridge/README.md`](poc/local-bridge/README.md) — it walks the current companion + extension flow end to end. Production packages under `packages/*` are coming online with M1.

## Contributing

Read [`AGENTS.md`](AGENTS.md) before making changes; use [`CONTRIBUTING.md`](CONTRIBUTING.md) for the repo workflow. Milestone work follows the convention `docs/milestones/Mn-name/{README,AGENT-PROMPT}.md`.
