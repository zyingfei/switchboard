---
bac_id: thread_obsidian_poc_001
bac_type: thread
title: Claude - Browser-owned MCP
provider: claude
source_url: https://claude.ai/chat/browser-owned-mcp
status: tracked
project: SwitchBoard
topic: Security
bucket: architecture
tags:
  - bac/thread
  - provider/claude
  - project/switchboard
related:
  - "[[BRAINSTORM]]"
created: 2026-04-26
bac_generated_at: "2026-04-26T09:00:00.000Z"
---
# Claude - Browser-owned MCP

We should validate a standalone BAC MCP server over stdio first because that is
the lowest-friction path for terminal clients.

## Notes

- Keep the server read-only for the PoC.
- Use provider captures for recent thread discovery.
- Build Context Pack text from the current workstream note plus captured
  assistant output.

## Source

https://claude.ai/chat/browser-owned-mcp
