# Switchboard - Obsidian AI Integration

- Provider: ChatGPT
- Captured at: 2026-04-26T02:33:19.732Z
- URL: https://chatgpt.com/g/g-p-69ec077b42948191a1fd309d64a860ae/c/69ebffe6-dca8-832b-86bf-b2fbe3884fd4?messageId=512dd262-1eb9-436c-8488-9bbe09547002
- Selector canary: passed
- Extraction config: 2026-04-25-chatgpt-v3

## ChatGPT 1 - user

can you help to introduce latest Obsidian with AI trend, the goal is to enrich context what it does, why it helps in AI era & how people are using with AI & knowledge mind map / graph it's unique, keep it in a brief md.

## ChatGPT 2 - assistant

I’ll ground this in current Obsidian capabilities and the AI/plugin ecosystem, then compress it into a brief Markdown-style intro you can reuse.

Below is a brief Markdown intro you can reuse.

## Obsidian in the AI Era

**Obsidian** is a local-first knowledge-management app built around Markdown notes, links, backlinks, tags, properties, graph view, Canvas, plugins, and now database-like **Bases**. Its core value is that your notes stay as plain-text Markdown files on your device, while Obsidian adds a rich thinking layer on top: backlinks, graph visualization, visual canvases, searchable properties, and plugins. Obsidian’s own positioning emphasizes private local storage, open formats, note linking, and a graph for discovering relationships between ideas. [Obsidian](https://obsidian.md/)

### Why it matters more with AI

AI makes Obsidian more valuable because LLMs need **high-quality personal context**. Random chat history is noisy; an Obsidian vault can become a curated long-term memory: project notes, meeting notes, architecture decisions, reading notes, snippets, research, prompts, diagrams, and personal reasoning. Because notes are local Markdown files, they are portable and easy to feed into AI/RAG workflows without being locked into one SaaS knowledge tool. [Obsidian](https://obsidian.md/)

The current direction of Obsidian also fits AI-era workflows: recent releases added/expanded **Bases** for database-like note views, a **CLI** for scripting and automation, Canvas backlink detection, and better capture/import flows. The public changelog shows Obsidian 1.12 public releases in March 2026, with 1.12 introducing the CLI and improving Bases, while 1.9–1.10 added Bases and richer view APIs. [Obsidian+1](https://obsidian.md/changelog/)

### What makes Obsidian unique

Obsidian is not just a note editor. It is closer to a **personal knowledge graph**:

| Layer | What it does | Why it matters for AI |
| --- | --- | --- |
| Markdown vault | Stores durable local notes | Portable AI context corpus |
| Links / backlinks | Connect ideas manually | Human-curated semantic graph |
| Graph View | Visualizes relationships between notes | Helps find clusters, gaps, and hidden connections |
| Canvas | Infinite 2D space for notes, files, media, web pages | Useful for architecture maps, concept maps, research boards |
| Bases | Database-like views over Markdown properties | Turns notes into structured AI-ready datasets |
| Plugins | Adds search, AI, automation, task/project workflows | Lets users compose their own AI workspace |

Graph View is a core plugin where notes become nodes and internal links become edges; local graph shows the neighborhood around the active note. [Obsidian](https://obsidian.md/help/plugins/graph) Canvas gives an infinite visual space to arrange notes, attachments, and web pages, saved as `.canvas` files using the open JSON Canvas format. [Obsidian](https://obsidian.md/help/plugins/canvas) Bases creates sortable/filterable database-like views over note properties, with data still stored in local Markdown files. [Obsidian](https://obsidian.md/help/bases)

### How people use Obsidian with AI

Common AI-era patterns:

1.
  **Personal RAG / chat with notes**
  
  Plugins such as Copilot provide vault-wide Q&A using retrieval-augmented generation, searching notes and passing relevant context to a chat model with citations back to source notes. [Copilot for Obsidian](https://www.obsidiancopilot.com/docs/vault-qa)
2.
  **Semantic discovery**
  
  Smart Connections uses AI embeddings to chat with notes and show related content, supporting local models or API-based models such as Claude, Gemini, ChatGPT, and Llama-family models. [GitHub](https://github.com/brianpetro/obsidian-smart-connections)
3.
  **AI-assisted writing and synthesis**
  
  Users draft essays, architecture docs, research summaries, meeting notes, project plans, and decision records, then use AI to summarize, rewrite, compare, or extract action items.
4.
  **Research capture pipeline**
  
  Obsidian Web Clipper saves highlights and page data into the vault, keeps clips local, stores them as Markdown, and supports templates and selectors for structured capture. [Obsidian](https://obsidian.md/clipper)
5.
  **Knowledge mind maps / architecture maps**
  
  Users combine links, local graph, Canvas, and Bases to build living maps of projects, systems, books, papers, people, technologies, and decisions.

### Best mental model

Obsidian is becoming a **local, durable, AI-ready knowledge operating system**:

> Capture raw information → organize as Markdown → link concepts → visualize relationships → structure with properties/Bases → retrieve with search/embeddings → ask AI to synthesize → keep refined knowledge back in the vault.

Its advantage in the AI era is not that it replaces ChatGPT, Claude, NotebookLM, Notion, or Cursor. Its advantage is that it can become the **source-of-truth memory layer** behind them: private, portable, graph-based, human-curated, and increasingly automatable.

## ChatGPT 3 - user

give a bit more context on how to integrate with it (read/write by 3rd party), combine the content as output

## ChatGPT 4 - assistant

I found the main integration surfaces: plain files, Obsidian URI, plugin API, the new CLI, community REST/MCP bridges, Web Clipper, Bases, and JSON Canvas. I’ll combine them into one reusable Markdown brief rather than only adding a patch.

Below is a combined brief Markdown-style output with the integration context added.

## Obsidian in the AI Era

**Obsidian** is a local-first knowledge-management app built around Markdown notes, backlinks, graph view, Canvas, Bases, properties, and plugins. Its key idea is “file over app”: your knowledge lives as durable local files, while Obsidian adds a rich thinking layer on top. Obsidian emphasizes private local storage, open file formats, user-owned data, and thousands of plugins for customization. [Obsidian](https://obsidian.md/)

In the AI era, this matters because LLMs are only as useful as the context they can access. A curated Obsidian vault can become a **personal long-term memory layer**: project notes, meeting notes, architecture decisions, research, book notes, diagrams, prompts, snippets, and personal reasoning. Instead of relying only on noisy chat history, AI tools can read a structured, human-curated knowledge base.

## What makes Obsidian unique

Obsidian is not just a note editor. It is closer to a **personal knowledge graph**.

| Layer | What it does | Why it helps with AI |
| --- | --- | --- |
| Markdown vault | Stores notes as local files | Portable, inspectable AI context |
| Wikilinks / backlinks | Connect notes manually | Human-curated semantic graph |
| Graph view | Visualizes relationships between notes | Helps discover clusters, gaps, related ideas |
| Canvas | Infinite visual board for notes, files, links, and groups | Good for mind maps, system diagrams, research maps |
| Bases | Database-like views over notes and properties | Turns Markdown notes into structured datasets |
| Plugins | Extend reading, writing, search, AI, capture, and workflows | Lets users compose their own AI workspace |
| CLI / API / REST / MCP bridges | Let external tools read and write vault content | Enables agents, scripts, automations, and third-party apps |

Obsidian 1.12 added a CLI for scripting, automation, and integration with external tools; it also improved Bases and made Canvas backlinks count in Backlinks and Graph view, which strengthens the “knowledge graph + visual map” model. [Obsidian](https://obsidian.md/changelog/)

## How third parties can integrate with Obsidian

There are several integration levels, from simple file access to deep plugin/API integration.

### 1. Direct file-system integration

An Obsidian vault is a folder of files. Third-party tools can read and write `.md` files directly, including YAML frontmatter/properties, wikilinks, tags, attachments, `.canvas` files, and `.base` files. This is the simplest approach for AI agents, scripts, ETL jobs, Git-based workflows, and batch import/export.

**Best for:** local AI indexing, RAG pipelines, Git-backed knowledge bases, migration scripts, batch note generation, daily summaries, architecture docs.

**Caution:** direct writes bypass Obsidian’s internal APIs. For safe writes, use atomic file writes, avoid editing the currently open note, preserve frontmatter, and prefer append-only inbox patterns when possible.

### 2. Obsidian URI integration

Obsidian supports `obsidian://` URIs for cross-app workflows. External tools can open a vault, open a file, create or add to a note, open daily notes, create unique notes, trigger search, or open the vault manager. [Obsidian](https://obsidian.md/help/uri)

**Best for:** lightweight capture buttons, mobile shortcuts, browser/bookmarklet workflows, “open this note in Obsidian” links, quick note creation.

**Limitation:** URI is good for triggering actions, but it is not a full read/write API.

### 3. Official plugin API

For deeper integration inside Obsidian, build a plugin. The official developer docs describe the Vault API: plugins can list Markdown files, list all files, read files with `read()` or `cachedRead()`, and use Obsidian-aware file operations instead of raw Node.js file access. [Developer Documentation](https://docs.obsidian.md/Plugins/Vault)

**Best for:** native Obsidian AI plugins, semantic search panels, custom views, writing assistants, knowledge graph tools, custom commands, domain-specific workflows.

**Why it matters:** plugins can integrate with Obsidian’s UI, workspace, commands, index, vault model, and user interaction patterns.

### 4. Obsidian CLI

The new Obsidian CLI lets external tools control Obsidian from the terminal for scripting, automation, and integration. This is important for AI-era workflows because CLI-native agents such as Claude Code, Codex CLI, or custom local agents can operate around the vault without only relying on brittle file hacks. [Obsidian](https://obsidian.md/changelog/)

**Best for:** automation, agent workflows, project scaffolding, vault maintenance, scripted capture, moving/renaming notes, AI-generated updates.

### 5. Local REST API plugin

The community **Obsidian Local REST API** plugin gives scripts, browser extensions, and AI agents authenticated HTTPS access to the vault. It supports reading, creating, updating, and deleting notes; patching headings, block references, and frontmatter fields; reading/writing the active file; periodic notes; search; tags; opening files; and executing Obsidian commands. [GitHub](https://github.com/coddingtonbear/obsidian-local-rest-api)

**Best for:** AI agents, MCP servers, browser companions, backend services, automations, external dashboards, cross-app workflows.

**Why it is powerful:** it gives a third-party process a clean read/write API without requiring that process to be an Obsidian plugin.

### 6. Web Clipper / browser capture

Obsidian Web Clipper captures web pages and metadata into local Markdown files. It supports templates, site-specific rules, metadata extraction, Schema.org variables, CSS selectors, and data manipulation before saving. [Obsidian](https://obsidian.md/clipper)

**Best for:** research pipelines, reading lists, paper capture, web-to-vault ingestion, AI summarization queues, source-backed notes.

### 7. Canvas and JSON Canvas

Obsidian Canvas files are JSON-based `.canvas` files. The JSON Canvas repository shows a structure with `nodes` and `edges`, including file nodes, text nodes, groups, coordinates, dimensions, and links. [GitHub](https://github.com/obsidianmd/jsoncanvas/blob/main/sample.canvas)

**Best for:** AI-generated mind maps, architecture diagrams, dependency maps, research graphs, project planning boards.

**AI pattern:** an agent can read notes, cluster concepts, then write a `.canvas` file that visually connects notes, entities, decisions, and open questions.

### 8. Bases as structured knowledge views

Bases is a core plugin that creates database-like views over Markdown notes and properties. Data remains in local Markdown files, while views can be saved as `.base` files or embedded in Markdown. Bases supports table, list, card, and map-style views, with filtering, sorting, grouping, and formulas. [Obsidian](https://obsidian.md/help/bases)

**Best for:** AI task queues, reading pipelines, project dashboards, paper trackers, decision logs, CRM-like personal knowledge views.

**AI pattern:** agents write structured frontmatter, then Bases becomes the human review/control surface.

## Practical AI integration patterns

### Pattern A: Vault as AI memory

Use Obsidian as the durable context store.

```overflow-visible
Markdown
---
type: architecture-note
project: tech-pulse
status: active
topics: [rag, recommender-system, ddia]
created: 2026-04-24
source: manual
---
# RAG vs Recommender Systems
## Summary
...
## Key links
- [[Retrieval-Augmented Generation]]
- [[Recommendation Systems]]
- [[DDIA - Data Models]]
```

AI can read these files, retrieve related notes, summarize them, and write refined conclusions back into the vault.

### Pattern B: Inbox → AI enrichment → reviewed knowledge

A third-party tool writes raw notes into an `Inbox/` folder. An AI agent later enriches them with summaries, tags, links, properties, and related-note suggestions.

```overflow-visible
Browser / meeting / CLI / mobile capture
↓
Inbox/*.md
↓
AI enrichment: summary, tags, entities, links, questions
↓
Human review
↓
Permanent notes / project notes / canvas / base
```

This keeps AI helpful without letting it silently corrupt the source of truth.

### Pattern C: Obsidian as a personal RAG corpus

An AI system indexes the vault using embeddings and search. It retrieves relevant notes, then answers questions with citations back to source files. Community AI plugins such as Copilot and Smart Connections follow this general direction: chat with notes, semantic discovery, related-note suggestions, and vault-aware Q&A.

### Pattern D: Obsidian as an agent workspace

An agent can:

1.
  Read project notes.
2.
  Inspect existing decisions.
3.
  Generate a new design note.
4.
  Update frontmatter status.
5.
  Create a Canvas mind map.
6.
  Add a `.base` dashboard view.
7.
  Leave TODOs for human review.

Emerging “agent skills” also target this workflow directly; for example, `obsidian-skills` describes skills that teach agents to use Markdown, Bases, JSON Canvas, and the Obsidian CLI. [SkillsLLM](https://skillsllm.com/skill/obsidian-skills)

## Recommended integration architecture

For a robust AI-era Obsidian workflow, use layered integration:

| Need | Recommended integration |
| --- | --- |
| Simple read-only AI context | Direct filesystem read |
| Batch import/export | Direct filesystem with validation |
| Quick capture from another app | Obsidian URI or Web Clipper |
| Browser-to-vault capture | Web Clipper or Local REST API |
| AI agent read/write | Local REST API, MCP bridge, or CLI |
| Native Obsidian UX | Plugin API |
| Visual mind map generation | Write `.canvas` JSON |
| Structured dashboards | Write Markdown properties + `.base` views |
| Safer human review | Write to `Inbox/` first, then promote |

## Why this helps in the AI era

Obsidian’s unique value is that it separates **knowledge ownership** from **AI interaction**. Your notes stay as local, portable files; AI becomes an optional reasoning layer on top. This is different from putting everything directly into a proprietary AI notebook or SaaS workspace.

The strongest workflow is:

```overflow-visible
Capture → Normalize → Link → Structure → Retrieve → Synthesize → Visualize → Review
```

Obsidian handles the durable knowledge layer: Markdown, links, backlinks, properties, Canvas, Bases, and plugins. AI handles summarization, search, clustering, rewriting, extraction, and reasoning. Together, Obsidian becomes a practical **personal knowledge graph + AI memory system** rather than just a notes app.

## ChatGPT 5 - user

bac-design-spec.html

File

deep-research-report-switchboard.md

File

based on the spec, can you try to give a poc scope (with possible tech / references) for the hardest part ? maybe a browser based mcp server + obsidian apis?

## ChatGPT 6 - assistant

I’ll treat the “hardest part” as the trusted local bridge: Chrome extension captures browser/AI context, exposes it to MCP clients, and writes canonical artifacts into Obsidian without becoming brittle or unsafe.

The big design choice is already clear: don’t make the Chrome extension itself the MCP server. Use the extension as the browser sensor/UI, and use a tiny local companion process as the MCP + vault bridge.

## PoC Scope: Browser-AI Companion × Obsidian × MCP

### 0. Core thesis

The hardest PoC is **not** the UI. It is the **trusted local bridge**:

> Can a Chrome extension observe/capture browser AI work, persist it as Obsidian-owned Markdown, and expose it as MCP tools to coding agents, all locally and safely?

That is the strongest technical wedge in the spec: side panel + on-page capture + Obsidian vault + localhost MCP, with privacy-first and no token-burning as hard constraints. bac-design-spec The competitive report also frames the real wedge as the combination of cross-provider coordination, local-first storage, notebook-canonical artifacts, provenance, context packs, and MCP-out to coding agents. deep-research-report-switchboard

---

## 1. Recommended PoC shape

### Do **not** make the Chrome extension itself the MCP server

A pure “browser-based MCP server” is the wrong center of gravity. The Chrome extension should be the **sensor + UI + capture surface**. The MCP server should be a tiny **local companion process**.

Reason: MCP’s standard transports are `stdio` and Streamable HTTP; `stdio` assumes the MCP client launches a subprocess, while Streamable HTTP assumes an independently running server. The MCP spec also explicitly warns local HTTP servers to bind only to localhost, validate `Origin`, and implement authentication. [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports?utm_source=chatgpt.com)

### Recommended PoC architecture

```overflow-visible
Mermaid
```

The local companion can talk to Chrome through either `localhost` HTTP/WebSocket or Chrome Native Messaging. Native Messaging is useful when you want Chrome to launch/manage the local host process; Chrome starts the native host as a separate process and communicates over stdin/stdout, and only extension pages/service workers—not content scripts directly—can use `runtime.connectNative()` / `sendNativeMessage()`. [Chrome for Developers](https://developer.chrome.com/docs/extensions/mv3/nativeMessaging?utm_source=chatgpt.com)

---

## 2. PoC objective

### Demo-worthy user story

> User highlights or captures content from ChatGPT/Claude/Gemini/web page → BAC writes a provenance-rich Markdown artifact into Obsidian → BAC updates a “Where Was I” Base dashboard → Claude Code/Cursor/Codex asks `bac.context_pack` and receives a clean Markdown context packet with source references.

This directly validates the spec’s “MCP both ways” section: BAC exposes cross-provider research memory as a localhost MCP server consumed by coding agents, while read tools ship first and write tools are deferred behind explicit opt-in. bac-design-spec

---

## 3. Hardest part to PoC

### Hardest part: local trust boundary + canonical memory projection

The non-trivial part is combining four systems that each have different trust models:

| Boundary | Why it is hard | PoC answer |
| --- | --- | --- |
| Browser → local process | Extension is sandboxed; MV3 service worker can suspend; content scripts cannot directly call native apps | Use side panel/service worker as router; queue events; send to local companion |
| Local process → MCP client | MCP clients can trigger local tools; local MCP servers can be risky | Read-only MCP tools by default; no shell execution from tool args |
| Local process → Obsidian | Need durable writes without corrupting vault files | Use Obsidian Local REST API first; direct filesystem fallback later |
| Captured content → reusable memory | Need provenance, redaction, versioning, and human-readable output | Append-only event log + Markdown artifacts + `.base` dashboard |

The Local REST API plugin is a practical first integration because it supports authenticated read/create/update/delete for vault files, patching headings/block references/frontmatter, active-file access, periodic notes, search, commands, and tags. [GitHub](https://github.com/coddingtonbear/obsidian-local-rest-api?utm_source=chatgpt.com) Obsidian Bases is also a good fit because data remains in local Markdown files/properties while `.base` files provide database-like views, sorting, filtering, and table/card/list/map layouts. [Obsidian](https://obsidian.md/help/bases?utm_source=chatgpt.com)

---

## 4. In-scope PoC features

### A. Chrome extension capture

**Goal:** prove browser-side observation and capture.

Scope:

-
  MV3 extension with side panel.
-
  Content scripts for:
    -
      `chatgpt.com`
    -
      `claude.ai`
    -
      `gemini.google.com`
    -
      generic web pages for selected-text capture.
-
  Capture selected text, page title, URL, timestamp, provider, thread-ish ID, and optional user-selected workstream.
-
  Side panel shows:
    -
      recent captures
    -
      current workstream
    -
      local bridge status
    -
      latest MCP query count.

Use Chrome’s Side Panel API for the persistent browser UI; it is available in Chrome 114+ MV3 and lets extensions host UI alongside the main page. [Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/sidePanel?utm_source=chatgpt.com) Use content scripts in isolated world by default, and avoid `MAIN` world unless a provider adapter truly needs it, because Chrome documents the extra interference/security risk when scripts share the page’s execution environment. [Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts?utm_source=chatgpt.com)

### B. Local companion process

**Goal:** provide stable local runtime that the browser and MCP clients can both use.

Recommended stack:

```overflow-visible
Node.js 22+
TypeScript
Hono or Express
SQLite + FTS5
@modelcontextprotocol/sdk
Zod
@noble/ed25519
gitleaks or secretlint for PoC redaction
```

The official MCP TypeScript SDK supports building MCP servers/clients, tools/resources/prompts, stdio, Streamable HTTP, and runtime middleware such as Node/Express/Hono helpers. [GitHub](https://github.com/modelcontextprotocol/typescript-sdk?utm_source=chatgpt.com)

Local companion responsibilities:

-
  Receive capture events from extension.
-
  Redact obvious secrets.
-
  Persist append-only event log.
-
  Generate content hash and provenance metadata.
-
  Write Markdown artifact to Obsidian.
-
  Update `.base` dashboard.
-
  Serve MCP tools.

### C. Obsidian projection

**Goal:** make Obsidian the canonical human-readable memory layer.

Write these files:

```overflow-visible
_BAC/
where-was-i.base
captures/
2026-04-25-chatgpt-auth-redesign-<shortid>.md
context-packs/
auth-redesign.latest.md
decisions/
2026-04-25-<decision>.md
```

Each capture artifact should include YAML frontmatter:

```overflow-visible
YAML
---
bac_id: capture_20260425_1432_e3a7
bac_type: capture
bac_provider: claude-web
bac_workstream: auth-redesign
bac_source_url: https://claude.ai/...
bac_thread_title:
"Stripe webhook signature flow"
bac_created_at: 2026-04-25T14:32:00-07:00
bac_content_sha256:
"sha256:..."
bac_prev_hash:
"sha256:..."
bac_signature:
"ed25519:..."
bac_redaction_count: 1
tags:
- bac/capture
- workstream/auth-redesign
---
```

This aligns with the spec’s “vault as canonical projection”: BAC writes plain Markdown, stores workstream graph data as YAML frontmatter, generates `.base` dashboards, and keeps the user’s data usable even if BAC is removed. bac-design-spec

### D. MCP tools

**Goal:** prove coding agents can consume browser/Obsidian memory.

Ship read-only tools first:

```overflow-visible
bac.recent_threads
bac.search
bac.workstream
bac.context_pack
bac.deja_vu
```

Optional gated write tool:

```overflow-visible
bac.append_decision
```

The spec already lists this exact direction: `bac.search`, `bac.recent_threads`, `bac.workstream`, `bac.context_pack`, `bac.deja_vu`, and a later write-style `bac.append_decision`. bac-design-spec

Example tool contract:

```overflow-visible
TypeScript
bac
.
context_pack({
workstream:
"auth-redesign"
,
maxTokens:
4000
,
includeCaptures:
true
,
includeDecisions:
true
,
sinceDays:
21
})
```

Returns:

```overflow-visible
Markdown
# BAC Context Pack: auth-redesign
## Current state
...
## Recent captures
### Claude · Stripe webhook signature flow · 2026-04-25
Source: obsidian://open?vault=research&file=_BAC/captures/...
...
## Decisions
...
## Open questions
...
```

---

## 5. Explicitly out of scope

Do **not** include these in the first PoC:

| Out of scope | Why |
| --- | --- |
| Auto-send into ChatGPT/Claude/Gemini | High brittleness and policy/safety complexity |
| Full DOM parsing of every AI provider | Start with selection/manual capture and limited provider adapters |
| `chrome://glic/*` or internal Chrome Gemini surfaces | Chrome internal pages are a separate access problem |
| Full semantic/vector memory | Start with SQLite FTS5; add embeddings after the bridge works |
| Custom Obsidian plugin | Use Local REST API first; native plugin later only if needed |
| Cloud sync or hosted backend | Violates the local-first PoC thesis |
| Multi-user/team mode | Keep single-user local trust boundary clean |
| Rich graph UI | Let Obsidian Bases/Graph/Canvas do most of the visualization |

The research report already says the OSS landscape gives you useful building blocks—Obsidian Local REST API, Web Clipper, Defuddle, mcp-chrome, mcp-memory-service—but does not give you the full product, especially not notebook-canonical workstream state, signed event logs, provenance-preserving dispatch, context-pack handoff, and MCP-out from browser memory. deep-research-report-switchboard

---

## 6. Security posture for PoC

This should be part of the PoC, not deferred.

Minimum rules:

-
  Bind local HTTP/MCP only to `127.0.0.1`.
-
  Require a random local API key for extension → companion.
-
  Validate `Origin` on HTTP/Streamable MCP.
-
  Use a fixed MCP tool allowlist.
-
  Never let MCP tool arguments become shell commands.
-
  Default MCP tools to read-only.
-
  Require explicit local UI toggle for `bac.append_decision`.
-
  Redact secrets before writing to Obsidian.
-
  Sign event-log entries after redaction, not before.
-
  Store raw secret matches only as redaction metadata, not plaintext.

MCP’s own transport spec warns local Streamable HTTP servers to validate `Origin`, bind to localhost, and authenticate connections to prevent DNS rebinding/local-server attacks. [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports?utm_source=chatgpt.com) MCP security docs also warn that local MCP servers have direct access to the user’s system and can become attractive targets, especially when they lack sandboxing or consent requirements. [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices?utm_source=chatgpt.com) Recent OX Security research also reinforces that MCP/server startup and local tool execution paths need hard allowlists and no unsanitized command execution. [OX Security](https://www.ox.security/blog/the-mother-of-all-ai-supply-chains-technical-deep-dive/?utm_source=chatgpt.com)

---

## 7. PoC success criteria

A good PoC should pass these tests:

| Test | Pass condition |
| --- | --- |
| Capture path | Highlight text in Chrome → appears in BAC side panel → stored locally |
| Obsidian path | Capture creates a Markdown file with valid frontmatter |
| Bases path | `_BAC/where-was-i.base` shows captures grouped by workstream/status |
| MCP path | Coding agent calls `bac.context_pack` and receives relevant Markdown context |
| Privacy path | Works with network disabled except localhost |
| Safety path | Fake API key/secret is redacted before file write |
| Resilience path | Chrome service worker suspend/resume does not lose queued capture |
| Audit path | Event log has `prev_hash`, `content_sha256`, and signature |
| Scope discipline | Write tools are disabled unless explicitly enabled |

---

## 8. Suggested 3-week build plan

### Week 1 — bridge skeleton

Build:

-
  MV3 extension with side panel.
-
  Local companion with `/health`, `/capture`, `/events`.
-
  Extension ↔ companion handshake.
-
  SQLite event log.
-
  Manual selected-text capture from generic pages.

Deliverable:

```overflow-visible
Highlight text → click BAC capture → event lands in local SQLite.
```

### Week 2 — Obsidian projection

Build:

-
  Obsidian Local REST API integration.
-
  Markdown artifact writer.
-
  `.base` dashboard generator.
-
  Redaction pass.
-
  Idempotent writes.

Deliverable:

```overflow-visible
Capture → Markdown note + frontmatter → Where Was I Base updates.
```

### Week 3 — MCP-out

Build:

-
  MCP stdio server.
-
  Tools:
    -
      `bac.search`
    -
      `bac.recent_threads`
    -
      `bac.context_pack`
    -
      `bac.deja_vu`
-
  Optional local HTTP MCP after stdio works.
-
  E2E test with mock MCP client.

Deliverable:

```overflow-visible
Claude Code / Cursor / Codex-style MCP client asks:
"Give me the latest context pack for auth-redesign"
→ receives cited Markdown context from browser captures + Obsidian.
```

---

## 9. Tech choices I would make

### Best PoC stack

| Layer | Pick | Why |
| --- | --- | --- |
| Extension framework | WXT + React + TypeScript | Good MV3 ergonomics, provider adapters, side panel |
| Local daemon | Node.js + TypeScript | Same language as extension; fastest MCP SDK path |
| Local API | Hono or Express | Simple localhost HTTP/WebSocket |
| MCP | `@modelcontextprotocol/sdk` | Official TypeScript path |
| Store | SQLite + FTS5 | Local, inspectable, easy search |
| Obsidian write | Local REST API first | Fastest authenticated read/write path |
| Obsidian fallback | Direct filesystem Markdown writes | Keeps “file over app” principle |
| Redaction | gitleaks/secretlint + simple regex | Enough for PoC |
| Signing | Ed25519 via `@noble/ed25519` | Simple content/event signing |
| Tests | Playwright + mock provider pages + temp vault | Tests browser + local process together |

### Later production option

If this gets serious, move the local daemon from Node to **Rust/Tauri** or **Go** for packaging, lower idle overhead, better filesystem handling, and more controlled distribution. Keep the MCP tool schema and event-log format stable so the runtime can be swapped.

---

## 10. Final PoC definition

```overflow-visible
Markdown
# BAC PoC: Local MCP + Obsidian Memory Bridge
## Goal
Validate that browser AI work can become durable, provenance-rich Obsidian memory and be reused by coding agents through MCP.
## Hardest part
Trusted local bridge across Chrome extension, local companion process, Obsidian vault, and MCP clients.
## In scope
- MV3 side panel
- selected-text capture
- limited provider adapters for ChatGPT / Claude / Gemini web
- local companion process
- SQLite event log
- redaction
- Markdown artifact writes
- `.base` dashboard generation
- read-only MCP tools
- context-pack export
## Out of scope
- auto-send
- full AI-provider automation
- Chrome internal Gemini surfaces
- custom Obsidian plugin
- cloud backend
- full vector memory
- team/multi-user mode
## Winning demo
1. Capture useful AI/web research from browser.
2. See it appear in Obsidian as Markdown.
3. See `_BAC/where-was-i.base` update.
4. Ask a coding agent for `bac.context_pack`.
5. Agent receives a clean, cited Markdown packet.
6. No data leaves the machine.
```

My strongest recommendation: **PoC the local companion + MCP + Obsidian bridge first**, with browser capture kept deliberately simple. That proves the unique moat. The provider-specific AI tab parsing can improve later; the durable local memory bridge is the part competitors and OSS building blocks do not already hand you fully assembled.

## ChatGPT 7 - user

you can refer to the github's switchboard to see PoCs done

## ChatGPT 8 - assistant

Good call — I’ll ground the scope against what already exists in `zyingfei/switchboard`, especially any PoC scaffolds, extension pieces, MCP/local bridge code, and Obsidian-related work.

Yes — after checking `zyingfei/switchboard`, I would **change the next PoC scope**. The repo already proves more than the earlier plan assumed.

## What is already proven in `switchboard`

There are two useful PoCs already:

### POC 1: `poc/dogfood-loop`

This proves the local-first workflow loop:

```overflow-visible
markdown note → fork targets → inject/dispatch → observe completion → store artifacts → converge → patch note
```

It already has WXT, React, TypeScript, Chrome MV3 side panel, a background coordinator, tab-based targets, IndexedDB/local persistence, Vitest, and Playwright e2e coverage. It also already proves local graph nodes/edges/events, Obsidian-shaped projection, Context Pack generation, in-process read-only MCP JSON-RPC smoke path, and lexical déjà-vu recall. [README](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/poc/dogfood-loop/README.md)

Important: it explicitly does **not** prove real Obsidian Local REST API integration, real MCP transport, native helper packaging, process lifetime management, real provider DOM stability, or production-grade security review. [README](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/poc/dogfood-loop/README.md)

### POC 2: `poc/provider-capture`

This separately proves visible-content capture from provider-like and real provider tabs. It detects ChatGPT, Claude, Gemini, and fixture tabs, captures visible conversation-oriented text without screenshots, stores captures locally in `chrome.storage.local`, and tests provider-specific selectors with fixtures. [README](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/poc/provider-capture/README.md)

Live validation is especially useful: Gemini signed-in conversation capture worked and was improved from `7 turns / 664 chars` to `15 turns / 23,570 chars`; ChatGPT is partially proven through shared/canvas capture; Claude live validation is still pending. [README](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/poc/provider-capture/README.md)

So the next hard PoC should **not** repeat capture, side panel, local graph, Context Pack, or fake MCP. Those are already seeded.

---

# Revised next PoC: `poc/local-bridge`

## One-line goal

Build the missing **local bridge** that turns existing browser-side captures/workstream state into:

```overflow-visible
real Obsidian writes + real MCP server transport + local trust boundary
```

This is the right next “hardest part” because the existing repo already has:

| Capability | Status |
| --- | --- |
| MV3 side panel | Proven |
| Background coordinator | Proven |
| Provider visible capture | Mostly proven |
| Local graph/event model | Proven |
| Context Pack generation | Proven |
| Obsidian-shaped projection | Proven |
| In-process MCP JSON-RPC core | Proven |
| Real Obsidian write path | Not proven |
| Real MCP server transport | Not proven |
| Extension ↔ local daemon bridge | Not proven |
| Native/helper packaging | Not proven |
| Security boundary | Not proven |

The current dogfood PoC has `src/mcp/server.ts` with `bac.recent_threads`, `bac.workstream`, and `bac.context_pack`, but it is an in-process JSON-RPC core, not a real MCP server process/transport. [server](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/poc/dogfood-loop/src/mcp/server.ts) The vault projection already produces `_BAC/events/...`, `_BAC/workstreams/current.md`, and `_BAC/where-was-i.base`, but only as projected files, not actual Obsidian writes. [projection](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/poc/dogfood-loop/src/vault/projection.ts)

---

# Recommended architecture

Do **not** put the real MCP server inside the Chrome extension. Keep the extension as the browser sensor/UI, and add a local companion process.

```overflow-visible
Mermaid
```

Why this shape: Chrome MV3 service workers are not a good durable process boundary. A real MCP server wants a stable local process. The browser extension should capture and route; the daemon should own MCP, Obsidian writes, indexing, signing, and local security.

---

# POC scope

## In scope

### 1. Local daemon

Create:

```overflow-visible
poc/local-bridge/
daemon/
src/
server.ts
mcpServer.ts
obsidianAdapter.ts
eventStore.ts
schema.ts
security.ts
tests/
extension/
...
```

Daemon responsibilities:

-
  Accept capture/workstream events from extension.
-
  Persist to SQLite.
-
  Write Markdown artifacts into Obsidian.
-
  Generate/update `_BAC/where-was-i.base`.
-
  Serve MCP tools over real transport.
-
  Expose local health/status for side panel.

Suggested stack:

```overflow-visible
Node.js 22+
TypeScript
Hono or Fastify
SQLite / better-sqlite3
@modelcontextprotocol/sdk
Zod
Vitest
Playwright e2e harness reused from existing PoCs
```

### 2. Extension → daemon bridge

Add a small client in the extension:

```overflow-visible
TypeScript
POST
http
:
//127.0.0.1:<port>/v1/captures
POST
http
:
//127.0.0.1:<port>/v1/events
GET
http
:
//127.0.0.1:<port>/v1/health
GET
http
:
//127.0.0.1:<port>/v1/context-pack/current
```

Use current provider-capture output as input. The provider-capture PoC already has active-tab detection, capture requests, local persistence, provider detection, visible-text extraction, and side panel preview. [README](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/poc/provider-capture/README.md)

Do not remove local extension storage yet. For PoC, make daemon sync additive:

```overflow-visible
capture locally in extension
+
send to local daemon when available
+
show “bridge connected / disconnected” in side panel
```

### 3. Obsidian adapter

Use the existing vault projection model as the starting point. The dogfood PoC already builds:

```overflow-visible
_BAC/events/YYYY-MM-DD.jsonl
_BAC/workstreams/current.md
_BAC/where-was-i.base
```

from nodes, edges, prompt runs, events, and thread registry. [projection](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/poc/dogfood-loop/src/vault/projection.ts)

For POC, support two write modes:

| Mode | Why |
| --- | --- |
| Direct filesystem write to configured vault path | Easiest to test with temp vault |
| Obsidian Local REST API | More realistic “Obsidian API” path |

Start with filesystem writes for deterministic e2e tests. Add Local REST API as an adapter behind the same interface.

Adapter shape:

```overflow-visible
TypeScript
interface
ObsidianAdapter
{
writeFile(
path
:
string
,
content
:
string
):
Promise
<
void
>;
readFile(
path
:
string
):
Promise
<
string
|
null
>;
search?(
query
:
string
):
Promise
<
ObsidianSearchResult
[]>;
open?(
path
:
string
):
Promise
<
void
>;
}
```

### 4. Real MCP server

Promote the existing in-process MCP core into a real server.

Current tool set can stay small:

```overflow-visible
bac.recent_threads
bac.workstream
bac.context_pack
bac.search
bac.get_capture
```

The repo already has `bac.recent_threads`, `bac.workstream`, and `bac.context_pack` in `src/mcp/server.ts`. [server](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/poc/dogfood-loop/src/mcp/server.ts) The Context Pack generator already emits Markdown with goal, prompt runs, AI/search outputs, adopted sources, open threads, and event-log slice. [contextPack](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/poc/dogfood-loop/src/context/contextPack.ts)

For POC, implement **stdio MCP first**. HTTP MCP can come later.

### 5. Minimal security posture

This PoC should prove the trust boundary, not defer it.

Required:

-
  Bind local HTTP only to `127.0.0.1`.
-
  Random local API key generated on first daemon startup.
-
  Extension stores only that local token.
-
  Reject requests without token.
-
  Reject non-local origins.
-
  Read-only MCP tools by default.
-
  No shell execution from MCP tool args.
-
  Redaction pass before Obsidian writes.
-
  Audit every bridge write as an event.

The repo’s brainstorm already sets privacy constraints: no full DOM capture, no cookies, no screenshots by default, bounded extraction, deny-lists, local event log, and privacy-first local mode. [BRAINSTORM](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/BRAINSTORM.md)

---

# What this PoC should explicitly **not** do

| Not in scope | Reason |
| --- | --- |
| Auto-send to real ChatGPT/Claude/Gemini | Provider automation risk; not needed to prove bridge |
| Full refactor of both existing PoCs | Too much churn |
| Vector DB / embeddings | Existing lexical déjà-vu is enough for bridge validation |
| Cloud sync | Violates local-first PoC clarity |
| Native installer | Later; first prove daemon contract |
| Production Obsidian plugin | Local REST / filesystem adapter first |
| Team/multi-user mode | Single-user local trust boundary first |

---

# Acceptance demo

The winning demo should be:

```overflow-visible
1. Start local bridge daemon.
2. Load provider-capture extension.
3. Open a Gemini / fixture provider tab.
4. Click “Capture active tab.”
5. Capture is stored locally in extension and sent to daemon.
6. Daemon writes:
- _BAC/events/YYYY-MM-DD.jsonl
- _BAC/workstreams/current.md
- _BAC/where-was-i.base
7. Run MCP client call:
bac.context_pack
8. MCP returns Markdown containing the captured provider content and source metadata.
```

This closes the biggest gap between the two existing PoCs.

---

# Test plan

## Unit tests

Add tests for:

```overflow-visible
schema: provider capture → normalized WorkstreamEvent
eventStore: append/list/search
obsidianAdapter: writes temp vault files
contextPack: includes captures from daemon store
mcpServer: tools/list + tools/call
security: rejects missing/invalid token
```

## Extension e2e

Reuse the current Playwright extension harness. Existing e2e already proves provider fixture capture and persistence across reload. [provider-capture.spec](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/poc/provider-capture/tests/e2e/provider-capture.spec.ts) Add a daemon-backed version:

```overflow-visible
fixture provider tab
→ capture active tab
→ daemon receives capture
→ temp Obsidian vault has Markdown projection
→ MCP smoke returns context pack
```

## Manual live validation

Keep it small:

| Provider | Required live validation |
| --- | --- |
| Gemini | Capture real signed-in conversation and write to Obsidian |
| ChatGPT | One normal loaded conversation-thread pass |
| Claude | One logged-in capture pass |

Provider-capture README says Gemini is already strong, ChatGPT still needs one more real conversation-thread pass, and Claude live pass is pending. [README](https://github.com/zyingfei/switchboard/blob/a81e29bd963e3dfaee37ab79c9c462eaaf9230cc/poc/provider-capture/README.md)

---

# Suggested issue / task wording for engineer

```overflow-visible
Markdown
# POC 3: Local Bridge — Real MCP + Obsidian Write Path
## Context
Existing POC 1 `poc/dogfood-loop` already proves the local-first workflow loop:
markdown note → fork targets → observe completion → store artifacts → converge → patch note.
It also proves local graph/event storage, Obsidian-shaped projection, Context Pack generation,
read-only in-process MCP JSON-RPC smoke, and lexical déjà-vu recall.
Existing POC 2 `poc/provider-capture` proves conservative visible-content capture from
ChatGPT/Claude/Gemini-like tabs, local storage, side panel preview, fixture tests, and live Gemini capture.
Do not rebuild those. Build the missing bridge.
## Goal
Create `poc/local-bridge` that proves:
1. Extension can send normalized capture/workstream events to a local daemon.
2. Daemon stores events in SQLite.
3. Daemon writes Obsidian-compatible files into a configured vault path.
4. Daemon serves real read-only MCP tools over stdio.
5. MCP `bac.context_pack` returns Markdown containing captured browser/provider context.
6. All paths are local-only and token-gated.
## In scope
- Node.js + TypeScript daemon
- localhost HTTP bridge API
- SQLite event store
- Obsidian filesystem adapter
- optional Obsidian Local REST API adapter behind same interface
- real MCP stdio server using `@modelcontextprotocol/sdk`
- extension bridge client
- Playwright e2e with temp vault
- security checks: localhost only, API token, read-only MCP default
## Out of scope
- real provider auto-send
- cloud sync
- vector embeddings
- production installer
- full provider DOM stability guarantees
- full Obsidian plugin
## Acceptance
Run:
```sh
cd poc/local-bridge
npm install
npm run compile
npm test
npm run build
npm run test:e2e
```

E2E must prove:

-
  fixture provider capture reaches daemon
-
  `_BAC/events/YYYY-MM-DD.jsonl` is written
-
  `_BAC/workstreams/current.md` is written
-
  `_BAC/where-was-i.base` is written
-
  MCP `bac.context_pack` returns captured content
-
  missing/invalid API token is rejected

```overflow-visible
---
## Bottom-line recommendation
The next PoC should be **POC 3: Local Bridge**, not another browser capture PoC.
The repo already has the two halves:
```text
dogfood-loop = workflow graph + projection + context pack + fake MCP
provider-capture = real-ish provider capture + side panel + local storage
```

The missing hardest piece is:

```overflow-visible
extension boundary → local daemon → real Obsidian writes → real MCP server
```

That is the piece that turns the idea from “nice extension prototype” into the actual moat: **a local-first browser memory ledger that coding agents can query and Obsidian can own.**

## ChatGPT 9 - user

deep-research-report-chatgpt-after-claude.md

File

please take a look at another opinion, no need to plan for timing, plan for PoC validate the most valuable areas can be done technically (and not overlap with other pocs)

## ChatGPT 10 - assistant

Yes. After reading the added opinion, I’d sharpen the PoC plan around **technical validation of the highest-value unknowns**, not around schedule or broad MVP buildout.

The new report’s main point is consistent with the earlier landscape analysis: this is viable only if the product is a **combination wedge** — cross-provider coordination, local-first storage, notebook-canonical artifacts, provenance, context packs, MCP-out, and safety — not “another AI browser” or generic memory layer. deep-research-report-chatgpt-af… The design spec also frames the V1 spine as side panel, on-page capture, vault projection, and localhost MCP, with privacy-first and “don’t burn tokens” as hard constraints. bac-design-spec

## Updated recommendation

I would **not** make the next PoC a generic “local bridge” only. I’d define a small **technical-value proof set** that validates the most differentiating claims and explicitly avoids repeating the existing PoCs.

The existing GitHub PoCs already cover:

| Area | Current status |
| --- | --- |
| Side panel / MV3 extension skeleton | Already seeded in `dogfood-loop` |
| Provider visible-content capture | Already seeded in `provider-capture` |
| Local graph / event model | Already seeded in `dogfood-loop` |
| Context Pack generation shape | Already seeded in `dogfood-loop` |
| Obsidian-shaped projection | Already seeded in `dogfood-loop` |
| In-process read-only MCP JSON-RPC | Already seeded in `dogfood-loop` |
| Gemini / ChatGPT / Claude-like capture fixtures | Already seeded in `provider-capture` |

So the next PoCs should validate **things not yet technically proven**:

1.
  Real local boundary: extension → native/local daemon → Obsidian → real MCP client.
2.
  Trust layer: redaction, provenance, taint, signing, and MCP-safe context output.
3.
  Value layer: no-token recall + useful context rehydration into coding agents.
4.
  Anchor layer: live thread registry + drift/version awareness across providers.

---

# PoC A — Real Local Bridge: extension → daemon → Obsidian → MCP

## Hypothesis

A browser extension can safely pass captured AI/browser work to a local process, persist it into Obsidian-owned files, and expose it to coding agents through a **real MCP server**, not an in-process mock.

## Why this is valuable

This is the hardest architectural claim in the product: **BAC is the local switchboard between browser AI tabs, Obsidian, and coding agents**. The design spec explicitly presents MCP as the moat: BAC exposes cross-provider research memory as a localhost MCP server consumed by Claude Code, Cursor, and Codex, with read tools first and write tools deferred. bac-design-spec

This also matches the competitive gap: competitors may have memory, browser assistants, or Obsidian capture, but the report argues the defensible wedge is the combination of local-first notebook artifacts plus MCP/coding-agent handoff. deep-research-report-switchboard

## What this must validate

```overflow-visible
provider-capture output
↓
extension bridge client
↓
native/local daemon
↓
SQLite/event store
↓
Obsidian files + .base dashboard
↓
real MCP stdio server
↓
Claude Code / Cursor / Codex-style MCP client
```

## Non-overlap with existing PoCs

Do **not** rebuild provider capture. Use the existing `provider-capture` output format.

Do **not** rebuild Context Pack logic. Reuse the existing `dogfood-loop` Context Pack generator.

Do **not** rebuild fake MCP JSON-RPC. Promote it into a real MCP server process.

## Recommended technical route

Use a **local daemon** rather than making the Chrome extension itself the MCP server.

Chrome Native Messaging is a good fit for this validation because Chrome starts a native host as a separate process and communicates over stdin/stdout; only extension pages/service workers can call `runtime.connectNative()` or `sendNativeMessage()`, so content scripts should route through the service worker. [Chrome for Developers](https://developer.chrome.com/docs/extensions/mv3/nativeMessaging)

For MCP, use the official TypeScript SDK. The MCP docs list TypeScript as a Tier 1 SDK, and the SDK supports creating servers, exposing tools/resources/prompts, building clients, and local/remote transports. [Model Context Protocol](https://modelcontextprotocol.io/docs/sdk)

For Obsidian, use either filesystem writes or Obsidian Local REST API. The Local REST API supports authenticated vault access, CRUD on files, heading/block/frontmatter patching, active-file access, periodic notes, search, commands, tags, and opening files in Obsidian. [GitHub](https://github.com/coddingtonbear/obsidian-local-rest-api?utm_source=chatgpt.com)

## Scope

```overflow-visible
poc/local-bridge/
daemon/
src/
server.ts
nativeHost.ts
mcpServer.ts
obsidianAdapter.ts
eventStore.ts
schema.ts
security.ts
extension/
src/bridgeClient.ts
tests/
e2e/local-bridge.spec.ts
```

Core pieces:

| Component | Validation target |
| --- | --- |
| `bridgeClient.ts` | Extension can deliver normalized capture/workstream events to daemon |
| `nativeHost.ts` or localhost HTTP | Local process boundary works reliably |
| `eventStore.ts` | Captures/events persist outside Chrome storage |
| `obsidianAdapter.ts` | Files land in real/temp Obsidian vault |
| `mcpServer.ts` | Real MCP client can call BAC tools |
| `security.ts` | API token, localhost-only, read-only default |

## Acceptance criteria

This PoC passes only if all of this works end-to-end:

```overflow-visible
1. Open provider-capture fixture or live provider tab.
2. Capture selected/provider content.
3. Extension sends event to local daemon.
4. Daemon writes:
- _BAC/events/YYYY-MM-DD.jsonl
- _BAC/captures/<capture>.md
- _BAC/workstreams/current.md
- _BAC/where-was-i.base
5. MCP client calls bac.context_pack.
6. Returned Markdown includes the captured content, source metadata, and Obsidian file references.
7. If daemon is offline, extension falls back to local-only storage without data loss.
8. If API token is invalid, daemon rejects the request.
```

---

# PoC B — Trust Ledger: redaction, provenance, taint, signing

## Hypothesis

BAC can turn untrusted browser/AI content into **safe, auditable, reusable context** before it reaches Obsidian or MCP clients.

## Why this is valuable

This is the part that separates “memory tool” from **trusted memory ledger**. The design spec emphasizes redaction preflight, version awareness, signing, and event-log provenance. bac-design-spec The report also calls out provenance, workstream state, safety preflight, and context handoff as gaps not fully covered by existing tools. deep-research-report-switchboard

This is also technically important because MCP local servers have real risk: the MCP security best-practices doc warns that local MCP servers can have direct system access and should use consent, sandboxing, minimal privileges, and restricted access; for HTTP transports it recommends authorization tokens or restricted IPC. [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices?utm_source=chatgpt.com)

## Non-overlap with existing PoCs

Existing PoCs capture and project content. This PoC validates whether captured content can be safely transformed into a **verifiable artifact**.

It should use existing capture fixtures but add adversarial cases:

```overflow-visible
- fake API keys
- fake OAuth tokens
- prompt-injection text
- “ignore previous instructions” payloads
- PII-like strings
- malicious Markdown links
- oversized pasted context
```

## Scope

Build a pipeline:

```overflow-visible
raw capture
→ normalize
→ detect secrets/PII/prompt-injection patterns
→ redact
→ assign taint labels
→ compute content hash
→ append event hash chain
→ sign event
→ write artifact
→ serve sanitized context via MCP
```

## Artifact example

```overflow-visible
YAML
---
bac_id: capture_20260426_001
bac_type: capture
bac_provider: claude-web
bac_workstream: auth-redesign
bac_source_url: https://claude.ai/...
bac_redaction_count: 2
bac_taint:
- prompt_injection_candidate
- secret_redacted
bac_content_sha256: sha256:...
bac_prev_hash: sha256:...
bac_signature: ed25519:...
---
```

## Acceptance criteria

This PoC passes if:

```overflow-visible
1. A fake API key is redacted before Obsidian write.
2. Redaction happens before hash/signature.
3. Prompt-injection-like content is wrapped or marked as tainted.
4. bac.context_pack never emits raw tainted content without label/boundary.
5. Event-log hash chain verifies.
6. Modifying one artifact causes verification failure.
7. MCP tools remain read-only unless explicitly configured otherwise.
```

## Key implementation notes

Use a conservative first pass:

```overflow-visible
- gitleaks or secretlint-style secret detection
- regex for common provider/API key shapes
- taint labels for suspicious instruction text
- SHA-256 content hash
- Ed25519 signing
- JSONL append-only event log
```

This PoC should be considered **mandatory**, not polish. Without it, MCP + browser capture + Obsidian writes create too much trust risk.

---

# PoC C — No-token Recall + Context Rehydration Quality

## Hypothesis

BAC can generate useful déjà-vu recall and coding-agent context packs **without calling an LLM** and without burning user tokens.

## Why this is valuable

The product’s “wow” is not just capture. It is:

```overflow-visible
“You already discussed this six days ago — here is the relevant thread, artifact, and decision.”
```

The design spec’s anchor surface includes calibrated déjà-vu recall in the 3-day to 3-week window. bac-design-spec The report also says one of the key market-fit questions is whether users value recall of prior work and context-pack handoff to coding agents. deep-research-report-chatgpt-af…

Existing `dogfood-loop` has lexical déjà-vu. This PoC should validate whether local-only retrieval is good enough to feel valuable.

## Non-overlap with existing PoCs

Do not rebuild basic lexical recall. Extend it into **hybrid local recall**:

```overflow-visible
FTS5 lexical search
+ optional local embeddings
+ freshness window
+ source diversity
+ workstream weighting
+ “seen by provider” / drift state
```

SQLite FTS5 gives efficient full-text search and built-in ranking/snippet helpers such as `bm25()`, `highlight()`, and `snippet()`. [SQLite](https://www.sqlite.org/fts5.html?utm_source=chatgpt.com) For local embeddings, Transformers.js can run models directly in the browser or JavaScript environment without a server and supports feature extraction/embeddings. [Hugging Face](https://huggingface.co/docs/transformers.js/?utm_source=chatgpt.com)

## Scope

Build a recall evaluator over existing and synthetic artifacts:

```overflow-visible
Input:
- current selected text
- current provider thread title
- current workstream
- recent capture/event corpus
Output:
- top 3 déjà-vu candidates
- why surfaced
- source note/thread
- confidence
- freshness
- suggested context-pack inclusion
```

## Acceptance criteria

This PoC passes if:

```overflow-visible
1. Given a current highlight, BAC retrieves relevant prior captures from 3–21 days ago.
2. Results include source path, provider, workstream, and snippet.
3. Results are ranked better than pure recency.
4. Repeated exact terms are not required; semantically related terms can match when local embeddings are enabled.
5. Context Pack uses recall results to include the right artifacts.
6. No network LLM call is required.
7. Results are explainable: lexical hit, semantic hit, same workstream, same source, or freshness match.
```

## Suggested tool outputs

```overflow-visible
TypeScript
bac
.
deja_vu({
text:
"derive idempotency key from request body"
,
workstream:
"auth-redesign"
,
windowDays: [
3
,
21
],
limit:
3
})
```

Returns:

```overflow-visible
JSON
{
"matches": [
{
"title":
"Stripe webhook signature flow"
,
"provider":
"claude-web"
,
"age_days":
6
,
"confidence":
"high"
,
"why": [
"semantic_match"
,
"same_workstream"
,
"freshness_window"
],
"path":
"_BAC/captures/stripe-webhook.md"
,
"snippet":
"the key should be derived from the request body..."
}
]
}
```

---

# PoC D — Live Thread Registry + Drift / Seen-State

## Hypothesis

BAC can maintain a useful **cross-provider thread registry** and detect context drift without deeply automating providers.

## Why this is valuable

The side panel is the anchor experience: “Where was I?” across ChatGPT, Claude, and Gemini. The design spec emphasizes active workstreams, provider tags, thread states, unread/waiting/stale states, and drift lines such as “Note v5 — Gemini saw v3.” bac-design-spec

This is also one of the clearest differentiators versus generic Obsidian capture. Obsidian Web Clipper can capture pages; BAC needs to know **which AI thread saw which context version**.

## Non-overlap with existing PoCs

`provider-capture` proves content extraction. This PoC should not focus on extracting more text. It should focus on **state tracking**:

```overflow-visible
thread identity
provider identity
last observed turn hash
last BAC context version seen by thread
status
staleness
drift
workstream membership
```

## Scope

Create a lightweight registry:

```overflow-visible
YAML
thread_id: bac_thread_claude_abc123
provider: claude-web
title: Stripe webhook signature flow
workstream: auth-redesign
last_observed_at: 2026-04-26T10:12:00-07:00
last_turn_hash: sha256:...
last_seen_context_version: 3
current_workstream_version: 5
status: drift
```

## Acceptance criteria

This PoC passes if:

```overflow-visible
1. Same provider tab is recognized across reloads when feasible.
2. New visible turns update `last_turn_hash`.
3. Workstream version increments when relevant notes/context pack changes.
4. Thread records track `last_seen_context_version`.
5. Side panel can show:
- unread-ish/new reply
- user-replied-last-ish
- stale
- drift
6. Drift is computed without sending tokens.
7. “Push delta” produces a delta packet, not an auto-send.
```

## Important scope guard

Do **not** implement real auto-send yet.

Validate only:

```overflow-visible
context v3 → context v5 delta calculation
delta packet generation
preflight display
manual copy / insert-ready payload
```

Real provider injection/auto-send can wait. The existing report warns that browser-native action is already a crowded platform-vendor battleground; the stronger wedge is durable, cross-provider continuity rather than controlling the browser better than Atlas or Claude in Chrome. deep-research-report-chatgpt-af…

---

# What I would deprioritize

| Area | Reason |
| --- | --- |
| More provider DOM extraction | Already partly proven; diminishing return until bridge/state layer works |
| More side-panel polish | Design is strong; technical moat is elsewhere |
| Full browser automation / auto-send | High brittleness and platform-threat overlap |
| Full semantic vector database | Start with FTS5 + optional local embeddings |
| Cloud sync | Contradicts first technical value proof |
| Team features | Not needed to validate local-first single-user wedge |
| Custom Obsidian plugin | Local REST + filesystem writes are enough for technical validation |

---

# Proposed PoC set, ranked

| Rank | PoC | Validates | Why it matters |
| --- | --- | --- | --- |
| 1 | **Real Local Bridge** | Extension → daemon → Obsidian → MCP | Proves the architectural moat |
| 2 | **Trust Ledger** | Redaction, taint, signing, auditability | Makes local memory safe enough to expose to agents |
| 3 | **No-token Recall + Context Rehydration** | Déjà-vu + context-pack quality without LLM calls | Proves “don’t burn tokens” can still feel smart |
| 4 | **Live Thread Registry + Drift** | Cross-provider state, seen-version, stale/drift status | Proves the “Where was I?” anchor is more than capture |

---

# Combined target architecture

```overflow-visible
Mermaid
```

---

# Final PoC definition

```overflow-visible
Markdown
# BAC Technical Value Validation PoCs
## Goal
Validate the highest-value technical claims that are not already proven by
`dogfood-loop` or `provider-capture`.
## Already proven / do not repeat
- MV3 side panel skeleton
- provider visible-content capture
- local graph/event model
- basic Context Pack generation
- Obsidian-shaped projection
- in-process MCP JSON-RPC smoke path
- lexical déjà-vu recall
## PoC A: Real Local Bridge
Prove extension → daemon → Obsidian → real MCP client.
Acceptance:
- provider capture reaches daemon
- daemon writes real vault files
- `.base` dashboard is generated
- real MCP client can call `bac.context_pack`
- invalid token is rejected
- offline daemon does not lose extension-local capture
## PoC B: Trust Ledger
Prove captured content can be safely stored and served.
Acceptance:
- fake secrets are redacted before write
- tainted content is labeled
- event hash chain verifies
- tampering is detected
- MCP output is sanitized and bounded
## PoC C: No-token Recall + Context Rehydration
Prove useful recall without LLM calls.
Acceptance:
- FTS retrieves relevant prior artifacts
- optional local embeddings improve semantic recall
- recall results include explainable reasons
- context pack includes useful recalled artifacts
- no network LLM call required
## PoC D: Live Thread Registry + Drift
Prove cross-provider state can be tracked.
Acceptance:
- provider threads have stable-ish IDs
- last turn hash updates
- workstream version increments
- last-seen context version is tracked per thread
- side panel can show stale/drift/unread-ish states
- delta packet can be generated manually
```

My strongest revised take: **PoC A is necessary but not sufficient.** The real moat is only proven when A + B + C are true together:

```overflow-visible
real local bridge
+ safe/provenance-rich memory
+ useful no-token recall/context handoff
```

Then PoC D validates the anchor UX that makes users feel the product every day: **“Where was I, what changed, and which AI thread is out of date?”**

## ChatGPT 11 - user

so shall i do browser own mcp? i remember i saw it suggested in earlier reports, but you against it later in the propsoal

## ChatGPT 12 - assistant

I’ll separate two meanings: “browser-owned MCP” as a product capability versus literally running an MCP server inside the Chrome extension. Those lead to different architecture choices.

Yes — **you should do “browser-owned MCP” as a product capability**, but **not as “the Chrome extension itself is the MCP server.”**

That distinction is the whole reconciliation.

## My corrected stance

Earlier reports were right that **MCP is part of the moat**: the design spec explicitly describes BAC exposing cross-provider browser research memory as a localhost MCP server consumed by Claude Code, Cursor, and Codex, with read tools first and write tools later. bac-design-spec The competitive reports also identify the durable wedge as the combination of cross-provider coordination, local-first storage, notebook-canonical artifacts, provenance, context packs, and MCP-out for coding agents. deep-research-report-chatgpt-af…

What I’m against is only this implementation:

```overflow-visible
Chrome extension service worker = the real MCP server
```

That is fragile. MCP’s official transports are `stdio` and Streamable HTTP. With `stdio`, the MCP client launches the server as a subprocess; with Streamable HTTP, the MCP server is an independent process. Local HTTP MCP servers should bind only to localhost, validate `Origin`, and use authentication. [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports?utm_source=chatgpt.com) Chrome Native Messaging also works by starting a native host as a separate process over stdin/stdout, and content scripts cannot call the native host directly; they must route through extension pages or the service worker. [Chrome for Developers](https://developer.chrome.com/docs/extensions/mv3/nativeMessaging?utm_source=chatgpt.com)

So: **yes to browser-owned MCP; no to pure in-extension MCP as the runtime.**

---

## The right model

Call it:

> **Browser-owned memory MCP, daemon-hosted transport.**

Meaning:

```overflow-visible
Chrome extension owns:
- logged-in browser session visibility
- provider capture
- tab/thread registry
- side panel UX
- “what did the user see?” authority
Local daemon owns:
- real MCP transport
- SQLite / event log
- Obsidian writes
- redaction / signing / trust ledger
- stable long-running process
```

Architecture:

```overflow-visible
Chrome Extension
provider capture + side panel + workstream state
↓
Local Companion / Native Host
event store + Obsidian adapter + trust ledger
↓
Real MCP Server
bac.context_pack / bac.search / bac.recent_threads / bac.deja_vu
↓
Claude Code / Cursor / Codex
```

That matches the later proposal: use a **local daemon** rather than making the Chrome extension itself the MCP server, while still making the browser memory layer the owner of the product value. Response: Obsidian AI Integrati…

---

## What not to build first

Do **not** build a generic “control my browser” MCP as the main PoC. That space already exists: projects like `mcp-chrome` position themselves as Chrome extension-based MCP servers for browser automation, tab control, screenshots/content extraction, and semantic search, and they already have meaningful OSS traction. [GitHub](https://github.com/hangwin/mcp-chrome?utm_source=chatgpt.com)

Your differentiated thing is not:

```overflow-visible
AI can click around my browser.
```

It is:

```overflow-visible
My browser AI work becomes durable, safe, provenance-rich memory
that Obsidian owns and coding agents can query.
```

So V1 MCP tools should be **read/context tools**, not browser-control tools.

---

## Recommended V1 MCP surface

Do this:

```overflow-visible
bac.recent_threads
bac.search
bac.workstream
bac.context_pack
bac.deja_vu
bac.get_capture
bac.verify_artifact
```

Defer this:

```overflow-visible
bac.click
bac.type
bac.navigate
bac.screenshot
bac.auto_send_to_chatgpt
bac.auto_send_to_claude
```

Maybe later add limited browser tools, but only after the memory ledger is proven:

```overflow-visible
bac.capture_active_tab
bac.capture_selection
bac.list_ai_tabs
bac.open_source_thread
bac.prepare_delta_packet
```

These are still “browser-owned,” but they are **capture/recall/workstream tools**, not general browser automation.

---

## Final answer

**Yes, do browser-owned MCP.**

But implement it as:

```overflow-visible
browser-owned data plane
+ local daemon MCP transport
+ Obsidian-backed memory ledger
```

Not as:

```overflow-visible
Chrome extension pretending to be a durable MCP server
```

The PoC should validate this exact claim:

> A logged-in browser extension can capture AI/web context that no server-side MCP can see, hand it to a local trusted daemon, write it into Obsidian, and expose it to coding agents through real MCP tools.

That gives you the moat without fighting existing browser-automation MCP projects head-on.

## ChatGPT 13 - user

i want to shorten the PoC path, this should focus on real poc's focus: areas where there are multiple architectural / techincal solutions, not try to build each steps invidivually, also a few decisions can be deferred like security hardening etc, we know this will already be done. So let's replan PoCs based on above instruction, and explain what PoC enables / proves / if fail, alternatives.

## ChatGPT 14 - assistant

Yes — this is the right correction. The PoC path should be **shorter and more decision-oriented**.

A PoC should not mean “build every layer.” It should mean:

> **Where there are 2–4 plausible architectures, build the thinnest experiment that tells us which branch to commit to.**

Given the existing PoCs already cover side panel, provider capture, local graph/event model, Context Pack shape, Obsidian-shaped projection, in-process MCP JSON-RPC, and lexical déjà-vu recall, we should **not** split the next work into “local bridge,” “trust ledger,” “recall,” and “thread registry” as separate build tracks. Your consolidated notes already identify those as known areas, but also show several are partially seeded and should not be rebuilt one by one. Response: Obsidian AI Integrati…

I would replan into **three architectural PoCs**.

---

# Revised PoC path

## PoC 1 — Browser-owned MCP architecture

### Decision to make

Where should the MCP capability actually live?

Candidate architectures:

| Option | Shape | Why plausible |
| --- | --- | --- |
| A. Extension-as-MCP | Chrome extension directly behaves like MCP server | Most “browser-owned,” but likely awkward with real MCP transports |
| B. Local daemon MCP + extension feed | Extension owns browser/session data; daemon owns MCP transport | Best alignment with MCP transport model |
| C. Existing browser MCP + BAC memory service | Use `mcp-chrome`/similar for browser automation; BAC only exposes memory | Fast, but risks losing product differentiation |
| D. Obsidian/file MCP only | BAC writes files; coding agents read via file/Obsidian MCP | Simplest fallback, but less “browser-owned” |

MCP’s standard transports are `stdio` and Streamable HTTP; `stdio` means the client launches a subprocess, while Streamable HTTP is an independent server process. That strongly favors **B: local daemon MCP + extension feed** over a pure Chrome-extension server. MCP’s own transport spec also says local HTTP servers should bind to localhost, validate `Origin`, and authenticate connections. [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports?utm_source=chatgpt.com) Chrome Native Messaging is also a natural bridge because Chrome starts a native host as a separate process over stdin/stdout, and content scripts must route through extension pages/service workers rather than calling the native host directly. [Chrome for Developers](https://developer.chrome.com/docs/extensions/mv3/nativeMessaging?utm_source=chatgpt.com)

### Thin PoC

Do not build full Obsidian, full recall, full security, or full provider support.

Use:

```overflow-visible
existing provider-capture event
+ existing dogfood-loop context pack
+ tiny local daemon
+ real MCP stdio server
```

Expose only two MCP tools:

```overflow-visible
bac.recent_threads
bac.context_pack
```

The daemon can use a temp JSON/SQLite file. It does not need polished persistence yet.

### What this enables

This validates the core moat from the design spec:

> browser-visible, cross-provider memory exposed to Claude Code / Cursor / Codex as MCP.

The spec explicitly frames this as the architectural novelty: server-side MCP servers cannot reach into the user’s logged-in browser sessions, while BAC can. bac-design-spec

### What it proves

Pass means:

```overflow-visible
A coding agent can call a real MCP server
→ receive context derived from browser-owned capture/workstream state
→ without needing BAC to become a generic browser automation tool.
```

It also proves the distinction we want:

```overflow-visible
browser-owned data plane
daemon-hosted MCP transport
```

### If it fails

Failure does **not** kill BAC. It tells us which fallback to use.

| Failure | Alternative |
| --- | --- |
| Native Messaging is too much friction | Use localhost Streamable HTTP daemon first |
| MCP clients dislike HTTP/local daemon config | Use stdio-only MCP launched by each client |
| Extension ↔ daemon lifecycle is brittle | Keep BAC as Obsidian/context-pack writer; expose MCP over files |
| Browser-control MCP products already cover too much | Do not compete on browser automation; expose memory/context only |
| Real MCP config is too annoying for users | Ship CLI/context-pack export first, MCP as advanced integration |

This PoC should **not** build `bac.click`, `bac.type`, `bac.navigate`, screenshots, or browser control. Existing browser-MCP projects already focus on that: `mcp-chrome` is described as a Chrome-extension-based MCP server for controlling tabs, screenshots, page extraction, bookmarks, and browser history, with strong OSS traction. [MCP.Directory](https://mcp.directory/servers/chrome-mcp?utm_source=chatgpt.com) BAC should prove **memory MCP**, not generic browser MCP.

---

## PoC 2 — Obsidian canonical projection architecture

### Decision to make

What is the right Obsidian integration contract?

Candidate architectures:

| Option | Shape | Why plausible |
| --- | --- | --- |
| A. Direct filesystem write | BAC writes Markdown / `.base` / `.canvas` files directly | Fast, local-first, simplest |
| B. Obsidian Local REST API | BAC reads/writes through authenticated Obsidian plugin API | Better app-aware integration |
| C. Custom Obsidian plugin | Native app integration, plugin API, deeper UX | More control, more build cost |
| D. Plain Markdown folder only | Obsidian is optional; any folder works | Good fallback, weaker Obsidian story |

The current design spec leans heavily on Obsidian as the canonical projection: BAC writes `.base` files once and lets Obsidian render table/filter/sort UI; YAML/Markdown makes the system lock-out-proof; provenance fields live in frontmatter. bac-design-spec The brainstorm also says Obsidian reduces scope because it is local-first, open-format, file-over-app, and supports Markdown, YAML, JSON Canvas, `.base` files, Local REST API, plugin API, and CLI paths. BRAINSTORM

The Local REST API is a credible branch because it supports authenticated read/create/update/delete, frontmatter/headings/block patching, active-file operations, search, periodic notes, tags, commands, and opening files. [GitHub](https://github.com/coddingtonbear/obsidian-local-rest-api?utm_source=chatgpt.com)

### Thin PoC

Use one existing workstream graph/context-pack output and test **two adapters only**:

```overflow-visible
Adapter 1: direct filesystem write
Adapter 2: Obsidian Local REST API
```

Write only:

```overflow-visible
_BAC/captures/<capture>.md
_BAC/workstreams/current.md
_BAC/where-was-i.base
```

Then read back enough to verify:

```overflow-visible
frontmatter persisted
source links preserved
dashboard file is valid enough for Obsidian to render
```

No custom Obsidian plugin. No full Canvas. No rich UI.

### What this enables

It determines whether BAC can make Obsidian the **source-of-truth memory layer**, not just an export target.

### What it proves

Pass means:

```overflow-visible
browser/AI work can become user-owned Obsidian artifacts
with enough structure for dashboards, backlinks, and later MCP retrieval.
```

This proves the product’s “notebook-canonical” claim. It also lets you avoid building custom dashboard UI because Obsidian/Bases can render much of it.

### If it fails

| Failure | Alternative |
| --- | --- |
| Local REST API setup is too much friction | Default to direct filesystem writes |
| Direct filesystem writes risk conflicts | Use Local REST API for writes, filesystem for read-only indexing |
| `.base` format is too brittle | Generate Markdown dashboard first; support Bases later |
| Obsidian users dislike community plugin dependency | Make Obsidian integration optional: plain Markdown vault first |
| Need deeper app hooks | Build custom Obsidian plugin later, after proving demand |

This PoC makes one major decision: **Obsidian adapter contract**. It should not also try to solve recall, security, or provider automation.

---

## PoC 3 — Rehydration architecture: local recall + thread state

### Decision to make

Can BAC deliver the “where was I?” value with local-only methods, or does it need semantic/LLM enrichment?

Candidate architectures:

| Option | Shape | Why plausible |
| --- | --- | --- |
| A. FTS/local lexical only | SQLite FTS over captures, notes, threads | Cheap, explainable, no token burn |
| B. FTS + local embeddings | Lexical plus semantic similarity | Still local, better recall |
| C. Capture-time summarization | Summarize/label each artifact with LLM | Better quality, burns tokens |
| D. User-curated graph | Workstream tags, claims, decisions, manual links | Reliable, but more user friction |

SQLite FTS5 is a good baseline because it supports full-text search with ranking/snippet helpers like `bm25()`, `highlight()`, and `snippet()`. [SQLite](https://www.sqlite.org/fts5.html?utm_source=chatgpt.com) Local embeddings are the next branch: Transformers.js can run models directly in the browser/JavaScript environment without a server and supports embeddings/feature extraction. [Hugging Face](https://huggingface.co/docs/transformers.js/?utm_source=chatgpt.com)

This PoC should include **thread state / drift** because rehydration is not only search. The product promise is: “which prior context matters, which thread saw which version, and what changed?” The design spec already shows drift as a first-class surface: “Note v5 — Gemini saw v3.” bac-design-spec The brainstorm also says the durable loop is the core principle: source artifact → capture → context pack → dispatch → response → claim/decision/question → freshness tracking. BRAINSTORM

### Thin PoC

Use a small corpus:

```overflow-visible
existing captures
+ synthetic prior threads
+ 2–3 workstreams
+ artificial context versions v1/v2/v3
```

Compare:

```overflow-visible
retrieval mode A: FTS only
retrieval mode B: FTS + local embeddings
```

Output only:

```overflow-visible
top déjà-vu matches
why this matched
context pack
thread seen-version / drift status
```

No beautiful UI. No live provider automation. No cloud LLM.

### What this enables

It decides whether “no-token recall” is technically good enough to be a product pillar.

### What it proves

Pass means:

```overflow-visible
Given a current highlight or workstream,
BAC can locally recover relevant prior work,
build a useful context pack,
and identify stale/drifted AI threads.
```

That validates the “where was I?” anchor without overbuilding.

### If it fails

| Failure | Alternative |
| --- | --- |
| FTS recall is too weak | Add local embeddings as default |
| Local embeddings are slow/heavy | Use embeddings only for selected workstreams or offline indexing |
| Local-only quality still poor | Add optional LLM enrichment at capture/converge time |
| Drift detection is unreliable | Make seen-version explicit: only track BAC-generated context packets |
| Thread identity is unstable | Track by tab/session/title/content-hash, not provider thread ID |
| Rehydration returns too much noise | Require user-curated `Decision`, `Claim`, `Open Question` artifact types |

This PoC is the one that decides whether BAC can keep its “don’t burn tokens” promise for recall, or whether AI enrichment is necessary.

---

# What to drop as separate PoCs

## Drop separate “Trust Ledger PoC”

Security and provenance matter, but they should not be a standalone architecture PoC right now.

Keep only minimal guardrails inside each PoC:

```overflow-visible
local-only
read-only MCP tools
no shell execution
bounded context output
fake-secret redaction smoke test
basic content hash
```

Defer:

```overflow-visible
production redaction engine
Ed25519 signing
Merkle chain verification
MCP quarantine system
screen-share safe mode
full permission UX
```

Those are important, but they are not the current architectural unknown. The design spec already assumes provenance and auditability, and the prior report treats security as mandatory but not necessarily the first decision branch. Response: Obsidian AI Integrati…

## Drop separate provider-capture PoC

Provider capture is already partly proven. More DOM work is incremental, not architectural. Your own prior consolidation says to avoid rebuilding provider capture and reuse `provider-capture` output. Response: Obsidian AI Integrati…

## Drop generic browser automation MCP PoC

That is a crowded adjacent space. Browser-control MCPs already exist; BAC should not spend the next proof on “can an MCP click buttons in Chrome?” [MCP.Directory](https://mcp.directory/servers/chrome-mcp?utm_source=chatgpt.com)

## Drop custom Obsidian plugin PoC

The plugin path is a fallback if filesystem/Local REST fail. It is not the shortest path to validate the product.

---

# Shortened PoC matrix

| PoC | Core architectural question | Enables | Proves | If fail, alternatives |
| --- | --- | --- | --- | --- |
| **1. Browser-owned MCP architecture** | Does MCP live in extension, daemon, existing browser MCP, or file/Obsidian layer? | Coding agents can consume browser-owned context | Real MCP can expose BAC memory without generic browser automation | stdio-only daemon, HTTP daemon, file MCP, Obsidian MCP, existing `mcp-chrome` integration |
| **2. Obsidian canonical projection** | Direct filesystem vs Local REST API vs plugin vs plain folder? | User-owned Markdown/Bases memory layer | Obsidian can be canonical, not just export | Direct FS, Local REST, Markdown dashboard, custom plugin later |
| **3. Rehydration architecture** | FTS-only vs local embeddings vs LLM enrichment vs user-curated graph? | “Where was I?” and no-token context packs | Local recall + drift/seen-state are good enough, or not | Local embeddings, optional LLM summaries, explicit context-packet tracking, curated artifact types |

---

# Recommended final PoC sequence

```overflow-visible
PoC 1: Browser-owned MCP architecture
↓
PoC 2: Obsidian canonical projection
↓
PoC 3: Rehydration architecture
```

These are not sequential product layers. They are **three branch decisions**.

If all three pass, the core product architecture is validated:

```overflow-visible
browser captures what cloud MCP cannot see
+ Obsidian owns the durable memory
+ coding agents consume it through MCP
+ recall/context packs work locally enough to feel useful
```

If one fails, you still have clear fallback paths rather than a dead end.

## ChatGPT 15 - user

I want to start the product with
1. user's own action first, but leave them the way to change it (e.g. a chat by default is just tracking, and they can actively add the chat into a group / topic or move it out, or even start new groups to breakdown the topic), but it should be extensible, e.g. a high level topic for SwitchBoard project, then user can create folder, Planning / High Level Design / Security / Payment etc, Planning can have subFolders, then tags can make some virtual organization & connections), if not correct, they can organize it around. This is the trim of the MVP scope I wish to consider (alternatively make PoC scope more focus).

2. Obsidian has some way to parse documents & generate graph relationships (https://obsidian.md/). We said we want to make Obsidian first priority in integration, and probably leverage the features & its ecosystem, so we offload some MVPs to it. But All integrations should not be hard dependencies, so the product still live without losing integration or adding integration doesn't need refactors.

## ChatGPT 16 - assistant

Yes — this changes the MVP and PoC focus in a good way.

Your product should start from **user-owned organization**, not automation-owned organization. The default should be:

> BAC tracks browser AI work passively, but the user decides when a chat/thread/source becomes part of a project, topic, folder, tag, or context pack.

That is the right trim. It avoids over-promising “AI automatically organizes everything,” and it makes the product feel controllable.

## Updated product principle

```overflow-visible
Track by default.
Organize by user action.
Suggest later.
Never make integration shape equal product shape.
```

So a chat is initially just:

```overflow-visible
tracked thread → ungrouped / inbox / recent
```

Then the user can actively:

```overflow-visible
add to project
move into topic/folder
remove from group
split into subtopic
tag it
link it to another thread/source/decision
promote part of it into a note/artifact
```

This is very compatible with Obsidian. Obsidian stores notes as Markdown files in a vault folder on the local filesystem, including subfolders, and it automatically refreshes when external changes happen. That makes it a good projection target, not necessarily the only source of truth. [Obsidian Help](https://help.obsidian.md/data-storage?utm_source=chatgpt.com)

---

# Revised MVP scope

## Core MVP object model

The product should have a **tool-independent organization model** first.

```overflow-visible
Workspace / Project
└── Topic Group / Folder
└── Subtopic / Subfolder
└── Items
```

Example:

```overflow-visible
SwitchBoard
Planning
Market validation
MVP scope
Dogfood loop
High Level Design
Browser capture
Local bridge
Obsidian projection
MCP surface
Security
Redaction
Permissions
Audit trail
Payment
Pricing
Subscription
Billing provider
```

But folders are only one axis. Tags and links should create virtual organization:

```overflow-visible
#security
#mcp
#obsidian
#planning
#open-question
#decision
#payment
```

That matches Obsidian’s own organization model: folders are available through File Explorer; users can create folders and subfolders, move files around, and use drag-and-drop or context menus. [Obsidian Help](https://help.obsidian.md/Plugins/File%20explorer?utm_source=chatgpt.com) Tags are also first-class in Obsidian, can live inline or in YAML frontmatter, and can be nested with slash syntax such as `#inbox/to-read`. [Obsidian Help](https://help.obsidian.md/tags?utm_source=chatgpt.com)

## MVP data types

Keep these few types:

| Type | Meaning |
| --- | --- |
| `Project` | High-level product/workspace, e.g. `SwitchBoard` |
| `Topic` | User-created group/folder, e.g. `Security`, `Planning` |
| `Thread` | Tracked AI chat/browser conversation |
| `Capture` | Selected text / visible provider content / page extract |
| `Artifact` | User-promoted note, decision, claim, source, or context pack |
| `Tag` | Virtual classification, many-to-many |
| `Link` | Relationship between items, e.g. “supports,” “contradicts,” “related,” “source-of” |

The important decision: **a thread can be tracked without belonging to a topic**.

Default state:

```overflow-visible
YAML
status: tracked
project: null
topic: null
tags: []
```

After user action:

```overflow-visible
YAML
status: organized
project: SwitchBoard
topic: High Level Design / MCP surface
tags:
- mcp
- obsidian
- architecture
```

---

# Product UX implication

## Default behavior

When the user opens or captures a chat:

```overflow-visible
BAC tracks it automatically
BAC does not force classification
BAC shows it in Recent / Ungrouped / Inbox
```

The side panel should have simple actions:

```overflow-visible
Add to Project
Move to Topic
New Topic
Tag
Link to...
Promote to Note
Remove from Project
```

## Suggested, not automatic

BAC can later say:

```overflow-visible
“This looks related to SwitchBoard / Security. Add?”
```

But it should not silently move things. This keeps the human as the organizer.

That is especially important because your user model is technical/product-heavy. Users doing design work often need to reorganize as understanding evolves. A topic like `Planning` may later split into:

```overflow-visible
Planning
Market
MVP
Risks
Roadmap
GTM
```

The product must treat reorganization as normal, not as correction of a mistake.

---

# Obsidian integration model

## Obsidian should be the first projection, not a hard dependency

This is the key architectural correction.

Do **not** make BAC’s internal data model equal to Obsidian folders.

Instead:

```overflow-visible
BAC core model
→ Projection adapter
→ Obsidian
→ plain Markdown folder
→ future Notion / Google Drive / local DB / Git repo
```

Obsidian should be the first-class integration because it gives you a lot for free:

| Obsidian feature | What BAC can offload |
| --- | --- |
| Vault as local folder | Durable user-owned storage |
| Markdown files | Notes/artifacts without lock-in |
| Folders/subfolders | Physical project/topic organization |
| Tags / nested tags | Virtual organization |
| Properties / YAML | Structured metadata |
| Graph view | Link visualization |
| Backlinks / outgoing links | Relationship discovery |
| Bases | Dashboards over notes/properties |
| Canvas | Mind maps / architecture maps |

Obsidian Graph view visualizes notes as nodes and internal links as edges, with local graph showing notes connected to the active note. [Obsidian Help](https://help.obsidian.md/plugins/graph?utm_source=chatgpt.com) Outgoing Links also shows explicit links plus unlinked mentions, which can help discover potential note relationships the user has not linked yet. [Obsidian Help](https://help.obsidian.md/plugins/outgoing-links?utm_source=chatgpt.com) Bases can create database-like views over notes and properties, with table/list/card/map layouts, while the underlying data remains in local Markdown files and properties. [Obsidian Help+1](https://help.obsidian.md/bases?utm_source=chatgpt.com) Canvas can visually arrange and connect notes, attachments, and web pages, saved as `.canvas` files in the open JSON Canvas format. [Obsidian Help](https://help.obsidian.md/plugins/canvas?utm_source=chatgpt.com)

So BAC should not rebuild all of this in MVP.

---

# Recommended projection format

## BAC internal model

Keep an internal canonical object like:

```overflow-visible
TypeScript
type
BacItem
=
{
id:
string
;
type:
"thread"
|
"capture"
|
"note"
|
"decision"
|
"claim"
|
"source"
;
title:
string
;
projectId?:
string
;
topicPath?:
string
[];
tags:
string
[];
links:
Array
<{
targetId:
string
;
relation:
"related"
|
"supports"
|
"contradicts"
|
"source_of"
|
"mentions"
;
}>;
source?: {
provider?:
"chatgpt"
|
"claude"
|
"gemini"
|
"web"
;
url?:
string
;
threadId?:
string
;
};
createdAt:
string
;
updatedAt:
string
;
};
```

## Obsidian projection

Map that to Markdown:

```overflow-visible
SwitchBoard/
Planning/
Market validation/
chatgpt-market-map.md
High Level Design/
MCP surface/
claude-mcp-architecture.md
Security/
redaction-boundary.md
_BAC/
dashboards/
where-was-i.base
switchboard.base
context-packs/
switchboard-mcp-context.md
```

Example note:

```overflow-visible
Markdown
---
bac_id: thread_01HT...
bac_type: thread
project: SwitchBoard
topic:
- High Level Design
- MCP surface
provider: claude
source_url: https://claude.ai/...
tags:
- mcp
- obsidian
- architecture
status: tracked
---
# Claude — MCP architecture discussion
## Summary
...
## Source
[Open original thread](...)
## Related
- [[Obsidian projection design]]
- [[Security / Redaction boundary]]
- [[SwitchBoard context pack]]
```

Obsidian’s Properties system supports tags and YAML-style metadata, including the `tags` property as a list. [Obsidian Help](https://help.obsidian.md/properties?utm_source=chatgpt.com) Bases syntax can also use file properties like `file.folder`, `file.links`, `file.backlinks`, `file.path`, and note properties from YAML frontmatter. [Obsidian Help](https://help.obsidian.md/bases/syntax?utm_source=chatgpt.com)

---

# What this changes in PoC planning

Your PoCs should now focus on **architecture choices around organization and projection**, not each implementation step.

## Drop this as a PoC focus

```overflow-visible
Can we capture provider content?
Can we show side panel?
Can we create a context pack?
Can we write one Markdown file?
Can we add basic security checks?
```

Those are either already proven, straightforward, or implementation tasks.

## Focus PoCs on decisions

There are now three real architectural questions.

---

# PoC 1 — User-owned organization model

## Question

Can BAC model user-driven organization cleanly without locking itself into Obsidian folders?

## Competing architectures

| Option | Description | Risk |
| --- | --- | --- |
| Folder-first | Project/topic hierarchy maps directly to folders | Simple, but rigid |
| Tag-first | Everything is flat, tags define organization | Flexible, but can feel messy |
| Graph-first | Items are nodes, organization is links | Powerful, but abstract |
| Hybrid | User-visible folders + tags + links | Best fit for MVP |

## Recommended test

Build a tiny organizer over existing tracked threads/captures:

```overflow-visible
Recent / Ungrouped
Project: SwitchBoard
Topics:
Planning
High Level Design
Security
Payment
Tags:
#mcp
#obsidian
#risk
#decision
```

Actions to validate:

```overflow-visible
Add chat to project
Move chat into topic
Create subtopic
Remove chat from topic
Add tags
Link two items
Promote selected content into note/decision
```

## What it enables

It proves BAC can start with passive tracking but let users gradually impose structure.

## What it proves

Pass means:

```overflow-visible
User can reorganize AI work without losing source/thread identity.
```

It also proves that BAC’s core model is independent of any integration.

## If it fails

| Failure | Alternative |
| --- | --- |
| Folder hierarchy feels too rigid | Make tags primary and folders optional |
| Tags feel too loose | Keep project/topic required for organized items |
| Users need multiple placements | Allow one primary topic plus many tags/links |
| Moving items breaks context packs | Context packs should query by IDs/tags, not file paths |
| Users want auto-organization | Add suggestions, but keep user confirmation |

---

# PoC 2 — Obsidian projection adapter

## Question

Can BAC project the same internal organization into Obsidian without making Obsidian a hard dependency?

## Competing architectures

| Option | Description | Risk |
| --- | --- | --- |
| Direct filesystem projection | Write Markdown/folders/Bases directly | Fastest, but must avoid write conflicts |
| Obsidian Local REST API | Use Obsidian plugin API via HTTP | Better app-aware path, but plugin dependency |
| Custom Obsidian plugin | Deepest integration | Too heavy for MVP |
| Plain Markdown export | Obsidian optional | Lowest dependency, less integrated |

## Recommended test

Use the output from PoC 1 and project it two ways:

```overflow-visible
Adapter A: direct filesystem Markdown
Adapter B: Obsidian Local REST API
```

Both should produce the same logical result:

```overflow-visible
SwitchBoard/
Planning/
High Level Design/
Security/
Payment/
_BAC/
switchboard.base
where-was-i.base
```

## What it enables

It lets Obsidian be the first integration while keeping the product alive without Obsidian.

## What it proves

Pass means:

```overflow-visible
BAC core model → Obsidian projection
BAC core model → plain Markdown projection
```

without core refactor.

## If it fails

| Failure | Alternative |
| --- | --- |
| Direct filesystem works better | Use filesystem as default; Local REST optional |
| Local REST works better | Use Local REST for Obsidian users; filesystem for non-Obsidian |
| `.base` is brittle | Generate Markdown dashboard first |
| Folder mapping is brittle | Store physical files under `_BAC/items`, expose topic views through Bases |
| Obsidian integration too much friction | Ship BAC as local organizer first, Obsidian export second |

---

# PoC 3 — Organization-aware context pack / MCP

## Question

Can coding agents consume context based on the user’s organization model?

This is more important than generic MCP.

## Competing architectures

| Option | Description | Risk |
| --- | --- | --- |
| Path-based context | Context pack from folder path | Simple but brittle after moves |
| Tag-based context | Context pack from tags | Flexible but noisy |
| Graph-based context | Context pack from links/neighborhood | Powerful but needs relationship quality |
| Hybrid query | Project/topic + tags + linked items | Best fit |

## Recommended test

Given:

```overflow-visible
Project: SwitchBoard
Topic: High Level Design / MCP surface
Tags: #obsidian #architecture
Linked items: Security / Redaction boundary
```

MCP tool:

```overflow-visible
TypeScript
bac
.
context_pack({
project:
"SwitchBoard"
,
topic: [
"High Level Design"
,
"MCP surface"
],
includeTags: [
"obsidian"
,
"architecture"
],
includeLinkedDepth:
1
})
```

Should return:

```overflow-visible
- threads in that topic
- promoted notes / decisions
- related linked items
- source URLs
- open questions
- Obsidian paths if available
```

## What it enables

This proves the key value:

```overflow-visible
User organization → reusable AI context
```

Not:

```overflow-visible
Random captured memory → noisy retrieval
```

## What it proves

Pass means:

```overflow-visible
User-controlled groups/tags/links can drive useful context packs and MCP tools.
```

That is the real MVP wedge.

## If it fails

| Failure | Alternative |
| --- | --- |
| Context pack too noisy | Require promoted artifacts only |
| Topic is too narrow | Include sibling topics or linked items |
| Tags add noise | Use tags only as filters, not expansion |
| Links are sparse | Add suggested links, user-confirmed |
| Agents need more structure | Output sections: decisions, claims, sources, open questions |

---

# Updated MVP trim

## MVP should include

```overflow-visible
Passive tracking of AI chats
Recent / Ungrouped view
User-created projects
User-created topics / folders / subfolders
Move in / move out
Tags
Links between items
Promote capture to note / decision / source
Obsidian projection adapter
Plain Markdown fallback adapter
Context pack by project/topic/tags/links
Read-only MCP tools over organized context
```

## MVP should defer

```overflow-visible
Auto-organization
Auto-send to AI providers
Complex provider automation
Full security hardening beyond basic guardrails
Custom Obsidian plugin
Full graph visualization inside BAC
Full vector database
Team collaboration
Payment/billing
```

---

# Revised product architecture

```overflow-visible
BAC Core
- tracked threads
- captures
- projects
- topics
- tags
- links
- promoted artifacts
- context-pack generator
Integration Adapters
- Obsidian projection
- plain Markdown folder
- future: Notion, Git, Google Drive, etc.
Agent Surface
- read-only MCP tools
- context_pack by project/topic/tag/link
- recent_threads
- search
- open_questions
```

The main rule:

```overflow-visible
BAC owns the organization model.
Obsidian renders and enriches it.
MCP consumes it.
```

Not:

```overflow-visible
Obsidian folders define BAC.
MCP defines BAC.
AI automation defines BAC.
```

---

# Final recommendation

I would revise the PoC path to:

| PoC | Core decision | Why it matters |
| --- | --- | --- |
| **1. User-owned organization model** | Folder-first vs tag-first vs graph-first vs hybrid | This defines the actual MVP experience |
| **2. Obsidian projection adapter** | Filesystem vs Local REST vs plugin vs plain Markdown | This keeps Obsidian first without making it a hard dependency |
| **3. Organization-aware context pack / MCP** | Path vs tag vs graph vs hybrid query | This proves user organization becomes useful AI context |

That is much sharper than building “local bridge,” “trust ledger,” “recall,” and “thread registry” as separate tracks.

The MVP becomes:

> **A browser AI work tracker where users organize chats and captures into their own project/topic/tag graph, project it into Obsidian or plain Markdown, and reuse that organization as context for AI/coding agents.**

## ChatGPT 17 - user

those are good thoughts regarding my comments, but too focused on decoupling, look at https://obsidian.md/, it has introduced top level ideas like Links, Graph, Canvas, etc, we should integrate them if they are available, but I'd like to ask you to combine all the context we discussed, and give a balanced PoC plan

## ChatGPT 18 - assistant

You’re right: the previous framing leaned too much toward “decoupling from Obsidian.” The better balance is:

> **BAC should be Obsidian-native when Obsidian is available, but not Obsidian-dependent for survival.**

That means we should actively use Obsidian’s top-level concepts — **Links, Graph, Canvas, Bases, Properties, Tags, folders, backlinks** — instead of treating Obsidian as only a Markdown export folder. Obsidian’s own product positioning emphasizes local/private notes, open file formats, Links, Graph, Canvas, plugins, and “your knowledge should last,” which maps very naturally to BAC’s proposed local-first browser-memory ledger. [Obsidian](https://obsidian.md/)

## Balanced product thesis

BAC should become:

> **A browser AI work tracker that lets users organize chats, captures, and decisions into Obsidian-native knowledge structures — folders, links, tags, graph, canvas, and bases — then reuse that organized context through MCP and context packs.**

So the hierarchy is:

```overflow-visible
Browser captures what happened.
User organizes what matters.
Obsidian renders the knowledge system.
BAC turns that system into reusable AI context.
MCP exposes it to coding agents.
```

Not:

```overflow-visible
BAC auto-organizes everything.
Obsidian is just an export.
MCP is generic browser automation.
```

The existing PoCs already cover a lot of lower-level pieces: side panel, provider capture, local graph/event model, Context Pack shape, Obsidian-shaped projection, in-process MCP JSON-RPC, and lexical déjà-vu recall. The next PoCs should therefore validate higher-level architectural choices rather than rebuild those pieces. Response: Obsidian AI Integrati…

---

# What BAC should own vs. what Obsidian should own

| Layer | BAC should own | Obsidian should own when available |
| --- | --- | --- |
| Browser observation | Tracked AI chats, source URLs, capture events, thread state | No |
| User organization | Project/topic assignment, move in/out, promote to note, tags, links | Reflect and enrich through files, folders, links, tags |
| Durable artifacts | Stable IDs, source provenance, context-pack boundaries | Markdown files, properties, backlinks, graph, bases, canvas |
| Visualization | Minimal side panel, recent/ungrouped, actions | Graph View, Canvas, Bases dashboards |
| Context reuse | Context-pack generator, MCP tools, retrieval policies | Obsidian note graph as the human-editable source |
| Integrations | Adapter contracts | Obsidian as first and richest adapter |

Obsidian is especially useful here because its vault is a local filesystem folder of Markdown files, and it automatically refreshes when external changes happen. That makes direct file projection technically viable, while still letting users edit/reorganize from inside Obsidian. [Obsidian Help](https://help.obsidian.md/data-storage?utm_source=chatgpt.com)

---

# Revised PoC plan

I would now use **three balanced PoCs**. Each PoC validates an architectural branch where multiple solutions are plausible.

## PoC 1 — Obsidian-native user organization

### Core question

Can BAC turn passively tracked browser AI work into an **Obsidian-native project/topic system** that users can reorganize manually?

This PoC validates your key MVP principle:

```overflow-visible
Track by default.
User organizes actively.
Suggestions come later.
```

### Competing approaches

| Approach | What it means | Risk |
| --- | --- | --- |
| BAC-only organizer | Keep all organization in BAC UI; Obsidian is export only | Misses Obsidian’s native power |
| Folder-first Obsidian | Project/topic hierarchy maps directly to folders | Simple, but can become rigid |
| Link/tag-first Obsidian | Flat notes; organization comes from tags and wikilinks | Flexible, but can feel messy |
| **Hybrid Obsidian-native** | Folders for projects/topics, properties for metadata, tags for virtual grouping, links for graph | Best balance |

### Recommended thin build

Use existing captured threads/captures from the prior PoCs. Add only the minimal user actions:

```overflow-visible
Add chat to project
Move chat to topic
Create subtopic
Remove from topic
Add tags
Create link to another item
Promote capture to note / decision / source
```

Example user structure:

```overflow-visible
SwitchBoard/
Planning/
MVP Scope.md
Market Validation.md
High Level Design/
Browser-owned MCP.md
Obsidian Projection.md
Security/
Redaction Boundary.md
MCP Permissions.md
Payment/
Pricing Questions.md
_BAC/
dashboards/
where-was-i.base
switchboard.base
context-packs/
switchboard-hld.md
```

Each projected note should use Obsidian-native structure:

```overflow-visible
Markdown
---
bac_id: thread_01HT...
bac_type: thread
project: SwitchBoard
topic:
- High Level Design
- Browser-owned MCP
provider: claude
source_url: ...
status: tracked
tags:
- switchboard
- mcp
- obsidian
- architecture
related:
- "[[Obsidian Projection]]"
- "[[Security/Redaction Boundary]]"
---
# Claude — Browser-owned MCP discussion
## Source
Original thread: ...
## Notes
...
## Related
- [[Obsidian Projection]]
- [[Security/Redaction Boundary]]
```

This format uses Obsidian Properties/YAML for structured metadata, including tags, links, dates, booleans, and lists. [Obsidian Help](https://help.obsidian.md/properties?utm_source=chatgpt.com) It also uses Obsidian internal links, which create a note network and can be written in wikilink or Markdown-link format. Obsidian can update internal links when files are renamed, which helps when users reorganize folders. [Obsidian Help](https://help.obsidian.md/Linking%20notes%20and%20files/Internal%20links?utm_source=chatgpt.com)

### What this enables

This enables BAC to become a **human-controlled knowledge organizer**, not just a capture extension.

It also makes Obsidian feel like the primary working surface:

```overflow-visible
Side panel: quick organization actions
Obsidian: deep organization, editing, linking, graph, canvas, dashboards
```

### What it proves

Pass means:

```overflow-visible
A tracked chat can move from “recent/unorganized”
→ into a user-owned project/topic/tag/link structure
→ without losing source identity or context-pack eligibility.
```

### If it fails

| Failure | Alternative |
| --- | --- |
| Folder hierarchy feels too rigid | Keep folders shallow: project/topic only; use tags/links for nuance |
| Tags feel too loose | Require one primary project/topic for “organized” items |
| Moving files breaks BAC state | Track by `bac_id` in frontmatter, not by file path |
| Users want Obsidian-first editing | Let Obsidian changes be read back into BAC through frontmatter/links |
| Users dislike file clutter | Store raw captures under `_BAC/items`, expose organized views through Bases |

---

## PoC 2 — Links, Graph, Canvas, and Bases as first-class surfaces

### Core question

Can BAC offload major MVP surfaces to Obsidian’s native concepts instead of building custom UI?

This is the PoC that directly addresses your latest comment.

Obsidian’s Links, Graph, Canvas, and Bases are not just integrations; they are product primitives. Obsidian Graph View visualizes notes as nodes and internal links as edges. [Obsidian](https://obsidian.md/help/Plugins/Graph%2Bview?utm_source=chatgpt.com) Canvas gives an infinite space to lay out notes, attachments, and web pages, connect them with lines, group related notes, and save the result as `.canvas` files using the open JSON Canvas format. [Obsidian Help](https://help.obsidian.md/plugins/canvas?utm_source=chatgpt.com) Bases creates database-like views of notes and properties, with table/list/card/map layouts, and stores the underlying data in local Markdown files/properties while saving views as `.base` files. [Obsidian Help](https://help.obsidian.md/bases?utm_source=chatgpt.com)

### Competing approaches

| Approach | What it means | Risk |
| --- | --- | --- |
| BAC custom graph | Build our own graph/mind-map UI | Expensive, duplicates Obsidian |
| Links-only | Generate internal links and rely on Graph View | Lightweight, but not curated enough |
| Canvas-first | Generate `.canvas` maps for projects/topics | Great visual surface, but may be too manual/visual |
| Bases-first | Generate dashboards for workstreams, captures, decisions | Great for lists/status, weaker for relationships |
| **Hybrid Obsidian surface** | Links create Graph; Canvas creates visual map; Bases creates dashboard | Best MVP leverage |

### Recommended thin build

From one project, e.g. `SwitchBoard`, generate four Obsidian-native surfaces:

```overflow-visible
1. Notes with internal links
2. Graph-visible relationships
3. Project Canvas
4. Bases dashboard
```

Example generated structure:

```overflow-visible
SwitchBoard/
_Index.md
Planning/
High Level Design/
Security/
Payment/
_BAC/
dashboards/
switchboard.base
where-was-i.base
canvases/
switchboard-map.canvas
```

### Required behaviors

**Links**

BAC writes explicit relationships as wikilinks:

```overflow-visible
Markdown
## Related
- [[High Level Design/Browser-owned MCP]]
- [[Security/Redaction Boundary]]
- [[Planning/MVP Scope]]
```

This lets Obsidian’s Graph View and backlinks work natively. The Backlinks plugin shows notes that link to the active note, while Outgoing Links also surfaces explicit outgoing links and unlinked mentions that may become future links. [Obsidian Help+1](https://help.obsidian.md/plugins/backlinks?utm_source=chatgpt.com)

**Graph**

Do not build a custom BAC graph yet. Use generated links and inspect whether Obsidian’s Graph View gives enough “knowledge graph” value.

**Canvas**

Generate a project map:

```overflow-visible
SwitchBoard project node
→ Planning group
→ High Level Design group
→ Security group
→ Payment group
Each group contains:
- key chats
- promoted notes
- decisions
- open questions
```

Canvas can include notes, files, media, and web pages, and can connect/group related cards visually. [Obsidian Help](https://help.obsidian.md/plugins/canvas?utm_source=chatgpt.com)

**Bases**

Generate dashboards like:

```overflow-visible
where-was-i.base
switchboard-threads.base
switchboard-decisions.base
switchboard-open-questions.base
```

Bases can filter/sort/group by file properties such as folder, path, links, tags, and note properties from YAML frontmatter. [Obsidian](https://obsidian.md/help/bases/syntax?utm_source=chatgpt.com)

### What this enables

This lets BAC avoid building heavy MVP UI:

```overflow-visible
Obsidian Graph = relationship visualization
Obsidian Canvas = mind map / design map
Obsidian Bases = project dashboards
BAC side panel = capture + organize + context actions
```

### What it proves

Pass means:

```overflow-visible
BAC-generated Obsidian artifacts feel native enough that users can continue organizing inside Obsidian.
```

It also proves whether the MVP can rely on Obsidian’s ecosystem instead of rebuilding graph, canvas, and dashboard features.

### If it fails

| Failure | Alternative |
| --- | --- |
| Graph View is too noisy | Generate fewer links; distinguish `explicit`, `suggested`, `source`, `related` links |
| Canvas is hard to maintain | Generate Canvas only for promoted topics, not every capture |
| Bases syntax/layout is brittle | Generate Markdown dashboards first, `.base` as optional enhancement |
| Users edit Obsidian and BAC misses changes | Add read-back scan for frontmatter, links, and file moves |
| Obsidian-native surfaces are not enough | Build a minimal BAC “map” view later, but only after validating need |

---

## PoC 3 — Organization-aware Context Pack and browser-owned MCP

### Core question

Can the user’s Obsidian-native organization drive useful AI context?

This is the bridge from knowledge management to AI utility.

The existing discussion already points to MCP-out/context-pack handoff as one of the durable differentiators, but the key is not “generic browser MCP.” It is:

```overflow-visible
organized browser AI work → Obsidian-native graph → reusable context pack → coding agent
```

MCP’s standard transports are `stdio` and Streamable HTTP; with `stdio`, the MCP client launches the server as a subprocess, which is why the actual MCP runtime should be daemon-hosted rather than implemented directly inside the Chrome extension. [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports?utm_source=chatgpt.com) Chrome Native Messaging can bridge the extension to a local host process, and Chrome documents that the native host runs as a separate process over stdin/stdout; content scripts must route through the extension service worker or extension pages. [Chrome for Developers](https://developer.chrome.com/docs/extensions/mv3/nativeMessaging?utm_source=chatgpt.com)

### Competing approaches

| Approach | How context is selected | Risk |
| --- | --- | --- |
| Folder/path-based | Use project/topic folder path | Simple, but brittle after reorganization |
| Tag-based | Use tags like `#mcp`, `#security` | Flexible, but noisy |
| Link-neighborhood-based | Use Obsidian links/backlinks around a note | Powerful, but depends on link quality |
| Canvas-based | Use nodes in selected Canvas group | Great for visual planning, but not always used |
| **Hybrid organization-aware** | Project/topic + tags + links + optional Canvas group | Best fit |

### Recommended thin build

Expose one MCP tool and one side-panel action:

```overflow-visible
TypeScript
bac
.
context_pack({
project:
"SwitchBoard"
,
topic: [
"High Level Design"
,
"Browser-owned MCP"
],
includeTags: [
"obsidian"
,
"architecture"
],
includeLinkedDepth:
1
,
includeCanvas:
"_BAC/canvases/switchboard-map.canvas"
})
```

Return:

```overflow-visible
Markdown
# Context Pack: SwitchBoard / High Level Design / Browser-owned MCP
## Goal
...
## Active decisions
- [[Security/Redaction Boundary]]
- [[High Level Design/Obsidian Projection]]
## Relevant threads
...
## Sources
...
## Open questions
...
## Related graph neighborhood
...
```

The important thing is that context comes from **user organization**, not from random full-text search alone.

### What this enables

This proves the most valuable loop:

```overflow-visible
User organizes browser AI work
→ Obsidian renders it as knowledge
→ BAC turns it into agent-ready context
```

That is stronger than “memory across chats” because it is controlled, explainable, and project-scoped.

### What it proves

Pass means:

```overflow-visible
A user-created project/topic/link/tag/Canvas structure can drive useful MCP context for a coding agent.
```

This validates the MVP wedge from the competitive report: vendor-neutral continuity with user-owned artifacts, not just a generic AI browser or universal memory layer. Response: Obsidian AI Integrati…

### If it fails

| Failure | Alternative |
| --- | --- |
| Context pack is too noisy | Include only promoted artifacts: decisions, notes, sources, open questions |
| Folder/topic context misses relevant items | Add link-neighborhood expansion |
| Tags create too much noise | Use tags only as filters, not expansion |
| Link graph is sparse | Add “suggested links” but require user confirmation |
| Canvas context is inconsistent | Treat Canvas as optional curated context, not the primary index |
| MCP setup is too much friction | Ship context-pack export first; MCP as advanced/dev-user mode |

---

# How the three PoCs fit together

```overflow-visible
PoC 1: User organizes browser AI work
↓
PoC 2: Obsidian renders it as links / graph / canvas / bases
↓
PoC 3: BAC turns that organization into context packs / MCP
```

This gives a more balanced MVP:

```overflow-visible
Browser tracking
+ user-owned organization
+ Obsidian-native knowledge graph
+ context reuse through MCP
```

---

# What to deliberately defer

These are important, but not needed to validate the balanced architecture:

```overflow-visible
Auto-organization
Auto-send into AI providers
Generic browser-control MCP
Full custom graph UI inside BAC
Custom Obsidian plugin
Production security hardening
Full vector database
Team collaboration
Payment/billing
```

Keep minimal guardrails only:

```overflow-visible
local-only
read-only MCP tools
bounded context output
basic redaction smoke test
stable IDs in frontmatter
```

Production security still matters, but it is not the architectural question being tested right now.

---

# Final balanced PoC matrix

| PoC | Architectural decision | Enables | Proves | If fail |
| --- | --- | --- | --- | --- |
| **1. Obsidian-native user organization** | Folder-first vs tag-first vs link-first vs hybrid | User-controlled project/topic model | Tracked chats can become user-owned knowledge artifacts | Shift weight among folders, tags, links; keep `bac_id` as stable identity |
| **2. Links / Graph / Canvas / Bases surface** | Custom BAC UI vs Obsidian-native surfaces | Offload graph, map, dashboard MVP to Obsidian | Obsidian is a real product surface, not an export target | Generate fewer links, use Markdown dashboards, make Canvas optional |
| **3. Organization-aware context pack / MCP** | Path vs tag vs link-neighborhood vs Canvas-driven context | Coding agents consume organized browser memory | User organization becomes reusable AI context | Use promoted artifacts only, optional LLM summaries, context-pack export before MCP |

---

## Bottom-line recommendation

Build the next PoC as an **Obsidian-native project workspace**, not a generic integration layer.

The winning demo should be:

```overflow-visible
1. BAC tracks several AI chats about SwitchBoard.
2. User adds them into:
SwitchBoard / High Level Design / Browser-owned MCP.
3. User tags some with #obsidian, #security, #architecture.
4. User links one thread to a promoted Decision note.
5. BAC writes Obsidian-native Markdown with properties and wikilinks.
6. Obsidian Graph shows the relationships.
7. Obsidian Canvas shows the project/topic map.
8. Obsidian Bases shows “Where Was I”, open questions, decisions, and threads.
9. BAC generates a context pack from that organization.
10. A coding agent retrieves it through MCP or a context-pack export.
```

That is the right MVP core:

> **User-owned browser AI work → Obsidian-native knowledge graph → reusable AI context.**
