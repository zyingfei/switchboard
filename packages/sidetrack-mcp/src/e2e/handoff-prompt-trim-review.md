# Trim review: shrinking the Codex handoff prompt

## What we ship today (447 chars)

```
# Coding handoff: Heap rank algorithm

sidetrack_thread_id: 2ZRHJ5ZHV9TDTT3A
sidetrack_mcp: ws://127.0.0.1:8721/mcp?token=<bridge-key>

The Sidetrack companion is running locally and exposes the thread's
full context (markdown, dispatches, annotations, recall) over MCP.
Connect to the endpoint above and call `tools/list` to see what's
available; `bac.read_thread_md` returns the conversation body.

## User's ask
…
```

| Region | Chars | Function |
|---|---|---|
| Title heading | 41 | Human signal — what this task is about |
| Two key/value lines | 105 | **Load-bearing** — agent needs both |
| Body paragraph | 274 | Explains the contract to a first-time reader |
| `## User's ask` + filler | 27 | Where the user types |

## Cuts considered

The body paragraph is ~60% of the prompt. Three plausible trims:

### Draft A — minimal (no instructions)
```
sidetrack_mcp: ws://127.0.0.1:8721/mcp?token=<key>
sidetrack_thread_id: 2ZRHJ5ZHV9TDTT3A

<user's ask>
```
**~140 chars (-69%).** Drops title + paragraph entirely.

### Draft B — keep title, drop paragraph
```
# Coding handoff: Heap rank algorithm
sidetrack_mcp: ws://127.0.0.1:8721/mcp?token=<key>
sidetrack_thread_id: 2ZRHJ5ZHV9TDTT3A

<user's ask>
```
**~190 chars (-58%).** Title remains for human readability.

### Draft C — title + one-line hint + ask
```
# Coding handoff: Heap rank algorithm
sidetrack_mcp: ws://127.0.0.1:8721/mcp?token=<key>
sidetrack_thread_id: 2ZRHJ5ZHV9TDTT3A
(connect → tools/list → bac.read_thread_md)

<user's ask>
```
**~225 chars (-50%).** Title + parenthetical breadcrumb that fits on one line.

## Review — which to pick

| Concern | Draft A (140) | Draft B (190) | Draft C (225) | Today (447) |
|---|---|---|---|---|
| Agent that already knows MCP | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ |
| Cold-call agent: "what's this?" | ✗ | ◔ (title) | ✓ (breadcrumb) | ✓ ✓ |
| User reading the prompt later | ✗ (looks cryptic) | ◔ | ✓ | ✓ ✓ |
| Token cost | great | great | good | wasteful |
| Avoids leaking chat URL | ✓ | ✓ | ✓ | ✓ |

**Recommend Draft C (225 chars).** Title + breadcrumb keep the
prompt human-readable when the user re-reads it later, and gives a
cold-call agent a one-line cue without the 274-char paragraph.

The verbose paragraph in the current prompt was front-loading the
contract for an agent that hadn't yet seen any MCP tooling. Modern
coding agents (Codex, Claude Code, Cursor) auto-discover MCP tools
via `tools/list` on connect — the paragraph is read once, never
acted on, and lives forever in the user's clipboard / shell history.

A two-character "tools/list" cue (Draft C) preserves the discovery
path without the explanatory text.

## Implementation

`buildCodingAgentPacket` in `entrypoints/sidepanel/components/PacketComposer.tsx`
plus the parallel branch in `entrypoints/sidepanel/App.tsx` lines
1488-1494. One-line edit per file.

## Cross-reference

The full e2e in `codexHandoff.test.ts` already enforces negative
assertions (no `https://chatgpt.com`, no `Tools you can call`, no
`Snapshot`); those still hold under Draft C. Two new asserts add
themselves: prompt is ≤ 250 chars and contains the `(connect →
tools/list → bac.read_thread_md)` breadcrumb.
