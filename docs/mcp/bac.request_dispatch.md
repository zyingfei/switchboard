# MCP Capability: bac.request_dispatch

## Purpose

Let an attached coding agent ask Sidetrack to dispatch a packet to a target AI through the normal dispatch ledger. This is the inbound half of the Codex-started flow: Codex registers with `bac.coding_session_register`, fetches context, then calls this tool when it wants Sidetrack to open/send work to another AI.

## Input

- `codingSessionId: string` — `bac_id` returned by `bac.coding_session_register`; must refer to an attached session.
- `targetProvider: "chatgpt" | "claude" | "gemini"` — destination AI provider.
- `title: string` — short label for Recent dispatches.
- `body: string` — packet text to send.
- `mode?: "paste" | "auto-send"` — defaults to `auto-send`.
- `workstreamId?: string` — defaults to the registered session workstream when present.
- `sourceThreadId?: string` — optional source thread association.

## Output

Returns `{ dispatchId, approval, status, requestedAt, targetProvider, mode, workstreamId? }`. `approval` is always `"auto-approved"` in the first implementation.

## Security And Failure Behavior

Requires `sidetrack-mcp` to be started with `--companion-url` and `--bridge-key`. The MCP server rejects calls whose `codingSessionId` is not currently attached. Dispatches are recorded through the companion `POST /v1/dispatches` path with `mcpRequest` metadata so the extension can recognize and route auto-approved inbound work.
