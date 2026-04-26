# Sidetrack

Side panel that keeps your active AI work from scattering across tabs, providers, searches, and coding sessions.

Sidetrack is a local-first browser AI companion built as a Chrome MV3 extension, a Node companion process, and a stateless MCP reader. It tracks active work across providers such as ChatGPT, Claude, and Gemini, while letting the user reorganize that work manually into nested workstreams instead of forcing one folder structure up front. The vault is the canonical state: plain filesystem data under `_BAC/`, plus Markdown, frontmatter, `.canvas`, and `.base` files, with the companion owning writes and the extension acting as sensor and UI. The MCP side is outbound for coding agents: read the tracked work, recent context, and generated packets without turning the browser extension into a general automation surface.

## Status

Planning and PoCs are in place, and `poc/*` is the evidence base for the substrate and architectural decisions rather than production code. Production scaffolding is being built under `packages/*` as M1 lands; milestone planning lives under `docs/milestones/` on the milestone branches that introduce it. The GitHub repo is [`zyingfei/switchboard`](https://github.com/zyingfei/switchboard) for backward compatibility, but the product name is Sidetrack.

## Repo navigation

- [`PRD.md`](PRD.md): current MVP scope and constraints.
- [`BRAINSTORM.md`](BRAINSTORM.md) and [`BRAINSTORM-INDEX.md`](BRAINSTORM-INDEX.md): full product surface and anchor map.
- [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md): agent workflow and repo-specific operating rules.
- [`CODING_STANDARDS.md`](CODING_STANDARDS.md) and [`standards/`](standards): load-bearing engineering standards for API, MCP, and extension work.
- [`checklists/`](checklists) and [`templates/`](templates): design-review checklists and contract templates.
- [`docs/adr/`](docs/adr): architectural decisions. [`0001-companion-install-http-loopback.md`](docs/adr/0001-companion-install-http-loopback.md) locks the companion install path.
- `docs/milestones/`: milestone plans and execution docs. This path is introduced on milestone branches.
- `design/`: design artifacts are brought forward per milestone-PR convention and may not exist on `main`.
- [`poc/`](poc): proof-of-concept work and observations; reference only, not production code.
- [`configs/openapi/`](configs/openapi) and [`configs/ts/`](configs/ts): shared OpenAPI and TypeScript configuration.

## Dev quick start

Prerequisites: Node 22+ and Chrome 147+. Today the most useful runnable entry point is [`poc/local-bridge/README.md`](poc/local-bridge/README.md), which documents the current companion-plus-extension path and the supporting verification flow. Production packages under `packages/*` are being introduced as M1 progresses.

## Contributing

Read [`AGENTS.md`](AGENTS.md) before making changes and use [`CONTRIBUTING.md`](CONTRIBUTING.md) for the repo workflow. Milestone work follows the milestone PR convention: `docs/milestones/Mn-name/{README,AGENT-PROMPT}.md`.
