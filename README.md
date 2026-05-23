# Sidetrack

A local-first side panel that keeps your active AI work from scattering across tabs, providers, searches, and coding sessions.

Sidetrack tracks the AI threads you have open across ChatGPT, Claude, and Gemini and lets you organize them into workstreams as the shape of the work becomes clear — not up front. It captures the conversations and the pages you read, makes them searchable, and surfaces "you've seen this before" connections while you browse. Everything stays in your own vault on disk, and a small read-only MCP server makes that work reachable to coding agents.

## Status

Working and dogfooded, pre-1.0. The Chrome MV3 extension and the Bun companion are real, tested, and run daily; the product surface is still evolving. There is no published installer — you build from source and run it yourself (see [`INSTALL.md`](INSTALL.md)). No account, no telemetry; the data is yours on disk under a `_BAC/` namespace.

The GitHub repo is [`zyingfei/switchboard`](https://github.com/zyingfei/switchboard) — the product name is Sidetrack.

## Packages

- **`packages/sidetrack-extension`** — the Chrome MV3 extension: the side-panel workboard plus content scripts that capture chats and page content.
- **`packages/sidetrack-companion`** — the Bun process that owns the vault, serves the localhost API, and runs recall search + the connections graph.
- **`packages/sidetrack-mcp`** — a read-only MCP server that exposes the vault to coding agents.

Proofs-of-concept that validated the substrate live under [`poc/`](poc) and are kept as evidence.

## Start here

- **Run it** — [`INSTALL.md`](INSTALL.md)
- **What it does and why** — [`PRD.md`](PRD.md)
- **Full product surface and locked anchors** — [`BRAINSTORM.md`](BRAINSTORM.md) (navigate with [`BRAINSTORM-INDEX.md`](BRAINSTORM-INDEX.md))
- **Architectural decisions** — [`docs/adr/`](docs/adr)
- **Working in this repo** — [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Engineering bar** — [`CODING_STANDARDS.md`](CODING_STANDARDS.md) and [`standards/`](standards)

## Contributing

Read [`AGENTS.md`](AGENTS.md) before making changes; use [`CONTRIBUTING.md`](CONTRIBUTING.md) for the repo workflow. `bun run verify` (format, lint, typecheck, test, build) is the pre-PR gate.
