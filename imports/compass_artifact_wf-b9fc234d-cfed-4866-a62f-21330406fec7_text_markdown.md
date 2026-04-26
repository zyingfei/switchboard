# BAC Brainstorm Consolidation: Decision-Ready Successor Document

> Research conducted April 2026. ~20 web searches across competitor scan, technical validation, and demand evidence. Citations are inline. Where 2026 dates appear in cited sources, that reflects the publish-date of the source page; treat marketing claims with appropriate skepticism.

---

## Part A — Goal 1 Findings: Late-2025/Early-2026 Competitor Reality Check

The competitive picture has shifted **significantly** since the November 2025 cutoff. Three structural moves matter for BAC's positioning:

1. **OpenAI and Anthropic both crossed the in-browser line.** ChatGPT Atlas (Oct 21, 2025; macOS-only as of Apr 2026) ships browser memories, agent mode, and a sidebar "Ask ChatGPT" that can rewrite text inline ([OpenAI](https://openai.com/index/introducing-chatgpt-atlas/), [Wikipedia](https://en.wikipedia.org/wiki/ChatGPT_Atlas)). Claude in Chrome went GA on **all paid plans (Pro/Max/Team/Enterprise)** in Dec 2025, with scheduled tasks, multi-tab workflows, recorded workflows, and a Claude Code↔Chrome integration that lets `claude --chrome` drive your real browser ([Anthropic](https://www.anthropic.com/news/claude-for-chrome), [Claude Code Docs](https://code.claude.com/docs/en/chrome)). Both are agentic browsers/extensions, not memory-ledger tools — different category, but they crowd BAC's surface area.
2. **A "personal AI memory" category has consolidated.** Mem0/OpenMemory, Supermemory (with Nova consumer app, Jan 2026), MemPalace, Letta/MemGPT, Zep, MemoryPlugin, AI Context Flow, MemSync, and dozens of MCP memory servers are all chasing "the memory layer for AI" ([Mem0](https://mem0.ai/blog/introducing-the-openmemory-chrome-extension), [Supermemory](https://blog.supermemory.ai/catch-up-with-our-unforgettable-launch-week/), [Bymar](https://blog.bymar.co/posts/agent-memory-systems-2026/), [Plurality](https://plurality.network/blogs/best-universal-ai-memory-extensions-2026/)).
3. **MCP is now the dominant integration substrate.** Thoughtworks Radar Vol.33 placed MCP on Platforms/Trial in Nov 2025 ([Thoughtworks](https://www.thoughtworks.com/en-us/insights/blog/generative-ai/model-context-protocol-mcp-impact-2025)); the official `@modelcontextprotocol/server-memory` and a long tail of community memory MCP servers are mainstream ([npm](https://www.npmjs.com/package/@modelcontextprotocol/server-memory)).

### Competitor Table (delta since Nov 2025)

| Product | One-liner | Overlap with BAC | Threat / complementary |
|---|---|---|---|
| **ChatGPT Atlas** ([source](https://openai.com/index/introducing-chatgpt-atlas/)) | OpenAI's Chromium-based browser; ChatGPT sidebar, browser memories (server-side, 30-day TTL on raw, 7-day on summaries), agent mode | Owns the "browser-as-AI-context" surface for ChatGPT-only users | **Threat** for ChatGPT-mono users; **non-threat** for multi-provider users (single-provider lock-in). Server-side memory contradicts BAC privacy pillar — a positioning wedge. |
| **Claude in Chrome** ([source](https://support.anthropic.com/en/articles/12012173-getting-started-with-claude-for-chrome), [source](https://code.claude.com/docs/en/chrome)) | Anthropic's MV3 extension; sidebar agent, scheduled tasks, recorded workflows, Claude Code `/chrome` bridge | Browser automation + per-site permissions — but no cross-provider memory or notebook integration | **Complementary**: BAC can be a *thread registry* across Atlas + Claude-in-Chrome + ChatGPT.com + Gemini, none of which see each other. Claude Code's `/chrome` bridge is a **direct precedent** for BAC's WebSocket localhost MCP bridge. |
| **Perplexity Comet** ([source](https://www.perplexity.ai/changelog), [source](https://www.perplexity.ai/comet)) | Chromium browser; Comet Assistant agent, voice mode, tab-synthesis, mobile (iOS/Android Mar 2026); now free for all PPLX accounts | Tab-aware AI, agent automation | **Threat for "ask across my tabs"** scenarios; **non-threat** for cross-LLM orchestration. |
| **Dia (Atlassian)** ([source](https://en.wikipedia.org/wiki/Dia_(web_browser)), [source](https://www.atlassian.com/blog/announcements/atlassian-acquires-the-browser-company)) | $610M Atlassian acquisition (closed Oct 2025); now adding Slack/Notion/GCal/Gmail/Linear integrations + Arc-style sidebar/spaces; "personal work memory" pitch | Closest **strategic** competitor — explicit "browser as context-aware workspace" + memory + work integrations | **Threat** if Dia ships portable cross-LLM threading. **Mitigation**: Dia is enterprise-flavored, macOS-first (Windows in early test Mar 2026), Atlassian-tilted; BAC stays solo-power-user, multi-provider-neutral, Obsidian-anchored. |
| **Edge Copilot / Copilot Pages** | Continues to expand in 2025–26 (not surveyed deeply this cycle) | Sidebar AI, page summarization | **Non-threat** for multi-provider workflow users. |
| **Brave Leo** | Browser-native LLM; privacy story | Sidebar AI | **Non-threat**: single-model, no cross-thread state. |
| **Cursor / Continue / Cody** ([source](https://www.blockchain-council.org/ai/cursor-ai-track-memory-across-conversations/), [source](https://forum.cursor.com/t/cursor-memory-persistent-searchable-memory-for-cursor-ai/156344)) | Cursor *removed* its Memories feature in v2.1.x late 2025; users routed to Rules files and community MCP servers | Editor-side memory only; users actively asking for cross-session memory | **Complementary** — they have *no* memory of your chat-tab work. BAC's MCP-server-exposing-personal-memory is exactly the missing link. |
| **Claude Memory (chat search + synthesis, Aug 2025; Memory Tool API)** ([source](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context), [source](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool), [source](https://simonwillison.net/2025/Sep/12/claude-memory/)) | `conversation_search` + `recent_chats` tools, 24h synthesized memory, project-scoped; Memory Tool client-side `/memories` for API users | **In-provider** memory only; nothing crosses to ChatGPT/Gemini | **Non-threat** to BAC's cross-provider scope; **enabler** — BAC could call `conversation_search` on user's behalf as an adapter. |
| **ChatGPT memory + Reference chat history** ([source](https://help.openai.com/en/articles/8983136-what-is-memory)) | Two systems: saved memories ("notepad") + chat-history reference (April 2025); both opt-in, server-side | Same — provider-locked | **Non-threat** to BAC's cross-provider scope. |
| **Gemini memory import** ([source](https://www.macrumors.com/2026/01/22/chatgpt-atlas-update-adds-tab-groups/)) | March 2026: Gemini added a feature to **import memory/context/chat history from other AI apps** | Provider-side — but a notable signal that the cross-provider context problem is real enough for Google to ship a one-way migration | **Validates the problem space**; **non-threat** because it's import-only, not bidirectional/live. |
| **Mem0 OpenMemory Chrome Extension** ([source](https://mem0.ai/blog/introducing-the-openmemory-chrome-extension), [source](https://github.com/mem0ai/mem0-chrome-extension)) | Auto-extracts facts ("lives in NYC", "vegetarian") from chat conversations, injects into ChatGPT/Claude/Perplexity/Grok/Gemini; cloud-stored on Mem0 servers | **Direct overlap** with auto-fact extraction; ~450 GitHub stars; **stores in Mem0 cloud, not local** ([dev.to](https://dev.to/anmolbaranwal/how-to-sync-context-across-ai-assistants-chatgpt-claude-perplexity-in-your-browser-2k9l)) — confirmed by maintainer comment | **Partial threat**: positioning is "facts about you", not "research workstreams + provenance + notebook ledger". Privacy contrast (cloud vs local-first) is BAC's wedge. |
| **AI Context Flow (Plurality Network)** ([source](https://plurality.network/ai-context-flow/)) | Chrome extension w/ "memory buckets", prompt rewrite, page-aware sidebar, MCP server, ChatGPT/Claude/Gemini/Perplexity/Grok; ~2,000 users | **Direct overlap** on "buckets + cross-LLM context"; offers MCP server and AI Sidebar | **Significant threat** — most architecturally similar product to BAC v1 spine. Differentiators: (a) BAC ships Obsidian as canonical projection (vault, not their dashboard), (b) workstream graph + lifecycle states (vs flat buckets), (c) Context Pack handoff format, (d) cross-thread provenance/cite-this-turn, (e) typed Save-as-Claim vs free-form bucket. |
| **MemoryPlugin** ([source](https://www.memoryplugin.com/)) | Long-term memory for ChatGPT, Claude, Gemini, DeepSeek, MCP, etc.; SaaS, $9/mo+ | Personal facts memory across providers, server-stored | **Partial threat** — paid SaaS, no local-first; Mem0/AIContextFlow are the bigger pressure. |
| **Supermemory + Nova consumer app** ([source](https://supermemory.ai/), [source](https://blog.supermemory.ai/catch-up-with-our-unforgettable-similar-launch-week/)) | API-first 5-layer "context infrastructure" (connectors, extractors, RAG, graph, profiles); Nova consumer app launched Dec 2025; Claude Code/Cursor/Windsurf/VSCode plugins via MCP | Cloud-first developer-platform play, but Nova consumer app pulls into BAC's user space | **Strategic threat to ICP** if Nova grows; **technical complement** if BAC integrates as a Supermemory consumer (unlikely given privacy pillar). |
| **MemPalace** ([source](https://blog.bymar.co/posts/agent-memory-systems-2026/)) | Viral April 2026 launch; LongMemEval headline numbers later disputed (Issue #27) | Verbatim recall / personal archive | **Non-threat** for browser/notebook users; reputational caution. |
| **Letta / MemGPT, Zep, Mem0, Honcho, OpenViking, ByteRover, Hindsight** ([source](https://blog.bymar.co/posts/agent-memory-systems-2026/), [source](https://medium.com/@bumurzaqov2/top-10-ai-memory-products-2026-09d7900b5ab1)) | Agent memory frameworks for builders | Developer infrastructure, not consumer browser | **Non-threat** to BAC's product surface; potential **adapter targets**. |
| **MCP memory servers (50+ on LobeHub/MCP registry)** ([source](https://lobehub.com/mcp?q=memory), [source](https://github.com/doobidoo/mcp-memory-service)) | doobidoo/mcp-memory-service, mcp-memory-keeper, knowledge-graph memory server (official), local-context-memory, etc. | Deep overlap on the *MCP-server-exposing-memory* angle | **Validates** that "MCP memory server" is a real category; **moats are weak** (none ship browser observation, all are dev-tool-side). BAC's MCP server is differentiated by being browser-observation-fed, not chat-log-injection-fed. |
| **Chrome MCP Server (hangwin)** ([source](https://github.com/hangwin/mcp-chrome)) | Chrome extension exposing browser as MCP server (20+ tools, SIMD-accelerated WASM vector ops, Streamable HTTP) | **Strong overlap on architecture** (extension-as-MCP-server pattern) | **Complementary precedent** — proves the pattern is viable; BAC's product framing (cross-AI workflow memory) is orthogonal to their browser-automation framing. |
| **Real Browser MCP, Browser MCP, Chrome DevTools MCP** ([source](https://github.com/ofershap/real-browser-mcp), [source](https://developer.chrome.com/blog/chrome-devtools-mcp)) | MCP+extension bridges to drive an existing Chrome session | Architectural pattern (WebSocket localhost MCP bridge) | **Complementary** — confirms the technical substrate BAC plans to use. |
| **MCP SuperAssistant** ([source](https://mcpsuperassistant.ai/)) | Browser extension that brings 6000+ MCP servers into ChatGPT/Perplexity/Gemini/Grok/AIStudio chat UIs; auto/manual tool execution | Cross-LLM integration via tools (not memory) | **Complementary** — different problem (tool-calls, not workstream memory). |
| **ChatHub** ([source](https://chathub.gg/), [source](https://www.tooljunction.io/ai-tools/chathub)) | Side-by-side multi-LLM chat (up to 6 models); 300k+ users, 4.7★ Chrome Store; $14.99–24.99/mo | Multi-LLM compare/dispatch, but each chat is a **fresh ChatHub session**, not your *existing* ChatGPT/Claude tabs | **Partial threat** for fork-and-converge users; differentiator: ChatHub uses its own session pool/API; BAC observes the user's already-paid tabs (the "don't burn tokens" pillar). |
| **LLM Council, Multi+LLM, Multi-LLM Hub, AI-MultiPrompt** ([source](https://chromewebstore.google.com/detail/llm-council-compare-ai-re/agnfmnfjhehoooaagjlbpdkkibjfaage)) | Send one prompt to N open AI tabs; "judge" feature scores responses; no API keys needed (DOM-driven) | **Direct overlap** on multi-target highlight dispatch | **Partial threat** — execution is shallow (no provenance, no notebook write-back, no workstream state, no thread registry). BAC differentiator is the *event log + workstream graph + Context Pack* underneath the dispatch. |
| **Memory Guy, OpenMemory variants** ([source](https://chromewebstore.google.com/detail/the-memory-guy/annalcmibkbhicclkcdmmdjiaocjmjam)) | Generic "inject prior context into next session" extensions | Lightweight overlap | **Non-threat** — feature parity, no architectural depth. |
| **Obsidian Web Clipper (Kepano/official)** ([source](https://obsidian.md/clipper), [source](https://chromewebstore.google.com/detail/obsidian-web-clipper/cnjifjpddelmedmihgijeibhnjfabmlf)) | Official Obsidian browser extension; templates, AI interpreter (BYO key incl. OpenRouter), highlights | Reading capture, AI-assisted clipping, vault writes | **Largest overlap on W2 (reading capture)**; **complementary** because Web Clipper does not handle chat-tab observation, thread registry, or dispatch. BAC should *interoperate*, not compete (e.g., respect Web Clipper templates). |
| **Web2MD, MarkDownload, SingleFile** ([source](https://web2md.org/blog/best-web-clipper-obsidian-ai-2026)) | AI-optimized markdown clipping for AI handoff (token counting, "send to AI" buttons) | Adjacent to Context Pack export | **Complementary**; weaker provenance/workstream model. |
| **Obsidian community: Obsidian CLI REST + MCP** ([source](https://github.com/dsebastien/obsidian-cli-rest)) | "Obsidian CLI REST" turns CLI commands into HTTP API + **MCP server** in one plugin (early 2026) | **Same architectural idea** as BAC's "vault as canonical projection accessed via MCP" | **Complementary precedent**; potentially a substrate BAC could build on instead of rolling its own client. |
| **Hypothesis client (BSD-2)** ([source](https://github.com/hypothesis/client), [source](https://www.npmjs.com/package/hypothesis)) | Mature web annotation toolkit; anchoring engine extracted as reusable modules | Highlight anchoring / provenance | **Confirmed BSD-2** licensed, dependency-friendly. Spec status: actively maintained, Internet Archive maintains a fork ([archive fork](https://github.com/internetarchive/annotate-client)). |
| **Defuddle (Kepano)** ([source](https://github.com/kepano/defuddle), [source](https://news.ycombinator.com/item?id=44067409)) | HTML→markdown extractor purpose-built for Obsidian Web Clipper; replaces Readability.js (which Kepano notes is "mostly abandoned") | Reading-capture extractor | **Confirmed**: maintained, MIT, 0.6.x stable as of mid-2025; site-specific extractors for ChatGPT/Claude/Gemini chat thread markdown export are an active workstream — **directly relevant to BAC observation**. |
| **PGlite + pgvector** ([source](https://supabase.com/blog/in-browser-semantic-search-pglite), [source](https://electric-sql.com/blog/2026/03/25/announcing-pglite-v04)) | WASM Postgres in browser; v0.4 (Mar 2026) shipped PostGIS, multiplexing, pgvector; 13M weekly downloads | Local vector store substrate | **Production-ready**; Supabase ships demo. Confirmed for BAC. |
| **Transformers.js v4 + WebGPU + EmbeddingGemma-300M** ([source](https://github.com/huggingface/transformers.js/releases/tag/4.0.0), [source](https://ai.google.dev/gemma/docs/embeddinggemma), [source](https://huggingface.co/blog/embeddinggemma)) | v4 (late 2025/early 2026) ships rewritten WebGPU runtime; EmbeddingGemma 300M, MRL-truncatable to 128/256/512/768d, runs in <200MB RAM, <22ms on EdgeTPU | Local embeddings | **Production-ready**; minor WebGPU compatibility caveats outside Chrome. |

**Bottom line for Goal 1:** The "personal AI memory" category is **crowded and getting more crowded**, but every entrant is one of: (a) provider-locked, (b) cloud-stored, (c) flat-buckets/facts (not workstream graph), (d) developer infra not consumer extension, or (e) chat-only (no notebook). **No competitor combines: cross-provider observation + local-first + Obsidian-canonical + MCP-server-out + workstream-lifecycle + Context Pack handoff + typed-save provenance.** That intersection is BAC's unique position, but the wall is closing — Dia, AI Context Flow, and Mem0 are the realistic 6–12 month threats.

---

## Part B — Goal 2 Findings: Per-Scenario Demand and Market-Gap Scoring

| # | Scenario | Demand | Gap | MVP-suitability | Evidence / notes |
|---|---|---|---|---|---|
| **a** | **Cross-provider thread registry** (single panel listing every chat thread across ChatGPT/Claude/Gemini with status) | **High** — Reddit/HN consistently complain about "lost ChatGPT thread", Cursor forum has multiple "memory across sessions" threads ([Cursor forum](https://forum.cursor.com/t/cursor-memory-persistent-searchable-memory-for-cursor-ai/156344)) | **Rare** — no product ships this exact panel. AI Context Flow has buckets, not threads with status. ChatHub has its own threads, not your tabs. Claude `recent_chats` exists but is intra-provider | **High** | Strongest "rare + desired" combination. |
| **b** | **Drift detection** (notebook edited after thread fed → "stale" badge + delta paste) | **Medium-high, latent** — users don't articulate it as "drift detection" but the pattern of "I updated the doc, now the AI is out of date" is universal in coding-agent threads | **Rare** — no consumer product ships this. Closest: Claude Projects + Cursor Rules can rely on file mtimes, but neither does delta-paste UX | **Medium-high** | Wow moment material; small implementation if event log + diff are in place. |
| **c** | **Highlight → multi-target parallel dispatch** | **Medium** — proven by ChatHub (300k users), LLM Council, AI-MultiPrompt presence ([ChatHub](https://chathub.gg/), [LLM Council](https://chromewebstore.google.com/detail/llm-council-compare-ai-re/agnfmnfjhehoooaagjlbpdkkibjfaage)) | **Common** — many shallow implementations | **Low for MVP differentiation** (commodity feature) but **valuable as a hook** if combined with provenance. |
| **d** | **Calibrated-freshness recall** (déjà-vu at 3-day–3-week recency) | **High latent demand** — every memory-product launch references "you re-explain yourself"; Claude/ChatGPT memory features (Apr 2025+) validate the problem ([OpenAI](https://openai.com/index/memory-and-new-controls-for-chatgpt/)) | **Rare on the *recency-weighted* axis** — competitors do "everything I ever told you" (which becomes noise) or "this session only". 3-day–3-week window is a unique calibration | **High** | **The most defensible positioning differentiator** in the consumer memory category. |
| **e** | **Context Pack export** (bucket → portable markdown bundle) | **Medium-high** — `context-pack.com`, `handoff-md`, Repomix, ai-context-builder all exist; MCP "context engineering" is a Thoughtworks Radar topic ([Thoughtworks](https://www.thoughtworks.com/en-us/insights/blog/generative-ai/model-context-protocol-mcp-impact-2025), [context-pack.com](https://www.context-pack.com/), [Repomix](https://repomix.com/)) | **Partial** — code-context bundles are common (Repomix, AGENTS.md, CLAUDE.md), but **research/decision-context bundles** are rare. context-pack.com is closest but flat-text-only | **Medium-high** | Strongest as a *format* + adapter (not a primary hook); commoditizes nicely for shareability. |
| **f** | **Workstream lifecycle state machine** | **Low explicit demand, high latent** — users don't ask for "lifecycle states", they ask "where was I"; Atlassian's Dia thesis explicitly bets on this ([Atlassian](https://www.atlassian.com/blog/announcements/atlassian-acquires-the-browser-company)) | **Rare** — workflow tools have states, AI memory tools don't | **Medium for MVP** (risk of looking like Jira-for-prompts); save for v1.5 unless tied to "Where was I" panel. |
| **g** | **MCP server exposing personal cross-provider research memory** | **High among MCP-aware devs** — every Cursor/Claude Code thread has someone asking for "memory MCP"; doobidoo/mcp-memory-service has 1,500+ tests ([GitHub](https://github.com/doobidoo/mcp-memory-service)) | **Crowded but undifferentiated** — 50+ memory MCP servers exist, but **none are fed by browser observation of user's actual chat tabs**. They're all chat-log-injection or note-storage | **High — this is the architectural moat** | The unique thing BAC's MCP server provides isn't *that it's an MCP server*, it's *what it speaks for*: your real cross-tab research history. |
| **h** | **Typed-save buttons (Save as Claim/Decision/OQ)** | **Low explicit, high latent for researchers/analysts** — adjacent to the "personal knowledge graph" community (Roam, Obsidian Dataview, Tana) | **Rare in chat-extension form** — Obsidian Bases ([Obsidian Bases](https://help.obsidian.md/bases)) and Dataview do this in vault, no extension brings it to chat-side capture | **Medium-high** | Best paired with Obsidian-side rendering (Bases dashboards), not standalone. |
| **i** | **Workstream graph mirrored to Obsidian frontmatter + Canvas + Bases** | **Medium** — Obsidian power users (~2M+ active) lean into YAML/Bases/Dataview heavily | **Rare/novel** — no external tool *writes* `.canvas` (JSON Canvas spec, MIT, [obsidian.md](https://obsidian.md/blog/json-canvas/)) or `.base` files programmatically as their primary projection. Some skills/Claude Skills exist for JSON Canvas ([LobeHub](https://lobehub.com/skills/kepano-obsidian-skills-json-canvas)) but no consumer product. AI Context Flow uses its own dashboard, not vault. | **High — this is BAC's architectural elegance** | Side-effect: vendor-lock-out (everything is plain Markdown/YAML). |
| **j** | **RedactionPipeline before any dispatch** | **Medium** — clipboard-redaction tools (ClipRedactor macOS, Paste Redactor, Prompt Guard VSCode) prove the pain ([ClipRedactor](https://github.com/cmore-zz/ClipRedactor), [Paste Redactor](https://addons.opera.com/en/extensions/details/paste-redactor-clipboard-pii-redaction/)) | **Rare in chat-extension form** — most are clipboard-level or IDE-level; chat-tab-level redaction is novel | **High as a safety primitive** (not as a hook). | Ship-blocking primitive — must be in MVP. |
| **k** | **Cite-this-chat-turn** (markdown footnote with provenance) | **Low explicit, high latent for researchers** | **Rare** — Hypothesis ([Hypothesis](https://github.com/hypothesis/client)) does web-page anchoring; nothing does turn-level chat citation with provenance + local archive ID | **Medium** | Differentiator for academic/researcher ICP, not core-loop driver. |
| **l** | **Fork-and-converge** (same prompt to N providers, side-by-side, per-chunk merge) | **Medium-high** — proven by ChatHub volume; merge UX is what's missing | **Common at the dispatch layer; rare at the convergence/merge layer** | **Medium** | Save the merge UX for v1.5; ship the dispatch-with-provenance in MVP. |
| **m** | **Dogfood loop end-to-end** (note → fork → notify → converge → patch note) | **Medium-high among power users** | **Rare** — no product chains all five steps | **High but scope-risky** — pick a slice for MVP. |

---

## Part C — Goal 3 Findings: Technical Validation

### Obsidian Local REST API plugin
- **Maintained**: Yes. Repo updated, `coddingtonbear/obsidian-local-rest-api` ([source](https://github.com/coddingtonbear/obsidian-local-rest-api)).
- **Install rate**: ~355,000 downloads, ~2,103 stargazers as of March 2026 ([Obsidian Stats](https://www.obsidianstats.com/plugins/obsidian-local-rest-api)). Healthy, growing.
- **API surface**: Full CRUD, surgical PATCH on heading/block/frontmatter targets (key for BAC YAML mirror), Dataview DQL, JsonLogic search, command execution, periodic notes, API extension interface.
- **Auth/transport**: HTTPS with self-signed cert, API-key bearer; optional HTTP. Localhost-only by default.
- **Alternatives**: `dsebastien/obsidian-cli-rest` (Feb 2026) — turns CLI commands into HTTP API + MCP server in one plugin, with Code Mode pattern (2 tools: search + execute) ([source](https://github.com/dsebastien/obsidian-cli-rest)). Advanced URI plugin still kicking. Several MCP wrappers around Local REST API.
- **Recommendation**: Stick with **coddingtonbear's Local REST API as primary**, monitor `obsidian-cli-rest` as alternative if its MCP shape proves cleaner. The PATCH-with-frontmatter-target endpoint is exactly what BAC's "mirror workstream-graph entities into YAML" design needs — no blockers.

### JSON Canvas spec
- **Status**: Open spec at [jsoncanvas.org](https://jsoncanvas.org/), MIT-licensed, hosted on `obsidianmd/jsoncanvas` GitHub. Spec versioned ("Spec 1.0" referenced explicitly in skill packages, [LobeHub](https://lobehub.com/skills/kepano-obsidian-skills-json-canvas)).
- **External writers**: Yes — TiddlyWiki community ([forum](https://talk.tiddlywiki.org/t/plugin-idea-read-write-obsidians-new-open-json-canvas-format/9308)), Obsidian Skills (Claude/Anthropic skills marketplace), `obsidian-advanced-canvas` plugin ([advanced-json-canvas](https://github.com/Developer-Mike/obsidian-advanced-canvas/blob/main/assets/formats/advanced-json-canvas/README.md)).
- **Caveat**: 16-char hex IDs, JSON-string newlines must be `\n` literal; Obsidian-rendered files have idiosyncratic edge color/style fields not in core spec.
- **Recommendation**: Safe to write `.canvas` programmatically. Treat as projection-only (regenerate on workstream-graph change), don't expect users to round-trip edit.

### Bases (`.base`) file format
- **Status**: Public, documented at [help.obsidian.md/bases](https://help.obsidian.md/bases) and [bases/syntax](https://help.obsidian.md/bases/syntax). YAML schema with filters/formulas/properties/views sections. Introduced in Obsidian 1.9.x ([changelog](https://obsidian.md/changelog/2025-08-18-desktop-v1.9.10/)).
- **Stability**: New (Aug 2025) — expect schema additions; users in forum noted documented syntax doesn't yet cover `columnSize`/`rowHeight` ([forum](https://forum.obsidian.md/t/full-bases-documentation/104442)).
- **External writers**: Limited — DeepWiki has a derived spec ([DeepWiki](https://deepwiki.com/obsidianmd/obsidian-help/2-editing-and-formatting)), Obsidian Skills marketplace has skills, but no significant external tool ecosystem yet.
- **Recommendation**: Write Bases programmatically for "Where was I" / "Open Questions" / "Stale Threads" dashboards. Pin a tested schema version, retest each Obsidian release. Treat as **bonus delight**, not core dependency — fall back to Markdown tables + Dataview for users on older Obsidian.

### MCP server inside a Chrome extension
- **Reference implementations exist**: `hangwin/mcp-chrome` (Streamable HTTP, 20+ tools, WASM-SIMD vector ops, native bridge over a localhost npm package) ([source](https://github.com/hangwin/mcp-chrome)); `ofershap/real-browser-mcp` (extension + WebSocket localhost MCP server, 18 tools) ([source](https://github.com/ofershap/real-browser-mcp)); MCP SuperAssistant; Browser MCP; Chrome DevTools MCP.
- **Service-worker-from-MCP**: Service workers can host fetch handlers but **cannot use `navigator.clipboard`** (must use offscreen documents) and have a finite lifetime; sustained MCP server endpoint should run as **a localhost native helper or paired-down WebSocket + extension content-script**, with the extension itself as a thin MCP host (consuming user-added MCP servers in a similar pattern to Claude Desktop).
- **Transports**: STDIO (out — no native-messaging needed if you use WebSocket/HTTP), Streamable HTTP, SSE, WebSocket localhost. Recommend **WebSocket localhost** for outbound (BAC-as-MCP-server), with optional HTTP for compatibility. Real Browser MCP and mcp-chrome both validate this pattern ([Real Browser MCP](https://github.com/ofershap/real-browser-mcp)).
- **Latency**: Sub-300ms for an in-extension MCP call hitting PGlite is achievable; cross-process WebSocket is single-digit ms.

### Provider memory feature evolution since Nov 2025
- **Claude**: Chat search + memory synthesis live for Pro/Max/Team/Enterprise (Aug–Sep 2025), exposed as `conversation_search` + `recent_chats` tools the model can call ([Simon Willison](https://simonwillison.net/2025/Sep/12/claude-memory/), [Claude Help](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)). **Memory Tool API (`memory_20250818`)** lets API users implement client-side `/memories` filesystem ([Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)) — **important for BAC**: this is the official surface for an external memory store to plug into Claude.
- **ChatGPT**: "Saved memories" (notepad) + "Reference chat history" (since April 2025), both opt-in, server-side ([OpenAI Help](https://help.openai.com/en/articles/8983136-what-is-memory)). Embrace The Red has documented internals ([source](https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/)).
- **Gemini**: Added a memory **import** feature March 2026 (one-way migration from other AI apps).
- **API/webhook for BAC integration**: **None bidirectional**. Claude's Memory Tool is the only documented API surface that lets a third-party memory store inject into a provider. BAC's primary integration shape remains **observation in the browser tab**, not provider API.

### transformers.js + WebGPU (early 2026)
- **v4** released early 2026 with rewritten C++ WebGPU runtime, runs in browser/Node/Bun/Deno, ~200 supported architectures ([transformers.js v4](https://github.com/huggingface/transformers.js/releases/tag/4.0.0)).
- **Performance**: WebGPU benchmarks show 60×+ speedup over WASM on supported hardware; all-MiniLM-L6-v2 on M2 Air does single-pass embedding in **8–12ms WASM** ([SitePoint](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/)); WebGPU is faster for batches but has shader-compile cold-start.
- **Models**: MiniLM-L6-v2 (~25MB, baseline), `mxbai-embed-xsmall-v1`, `EmbeddingGemma-300M` (308M params, MRL-truncatable to 128/256/512/768d, <200MB RAM quantized, 100+ languages, 2K context) ([Google](https://ai.google.dev/gemma/docs/embeddinggemma), [HF blog](https://huggingface.co/blog/embeddinggemma)).
- **Caching**: ONNX models cache via fetch + HTTP cache; OPFS / IndexedDB persisted via custom code is standard pattern.
- **Corpus size for <200ms top-10 retrieval**: With MRL@256 truncated EmbeddingGemma in PGlite + pgvector + HNSW, **~50,000–100,000 chunks comfortably under 200ms** on consumer hardware. WebGPU embed for the *query* is the bottleneck (~30–80ms), not retrieval. Rebuild HNSW lazily, persist to PGlite IndexedDB.
- **Recommendation**: **MiniLM-L6-v2 for v1** (smallest, fastest, best for incremental embed-on-capture); **EmbeddingGemma-300M MRL@512 as opt-in upgrade** for users who want multilingual / longer-context. Keep both behind an embedding-adapter interface.

### PGlite + pgvector + HNSW
- **Production-ready**: Yes. v0.4 (Mar 2026, [ElectricSQL](https://electric-sql.com/blog/2026/03/25/announcing-pglite-v04)). 13M weekly downloads. pgvector confirmed ([Issue #18](https://github.com/electric-sql/pglite/issues/18)). Supabase ships an [in-browser semantic-search demo](https://supabase.com/blog/in-browser-semantic-search-pglite) on PGlite + Transformers.js.
- **Persistence**: IndexedDB-backed in browser. Single user/connection model fits an extension well.
- **HNSW**: pgvector ships HNSW indexes — supported in PGlite via dynamic extension loading.
- **Caveat**: 3MB gzipped + WASM payload; in a Chrome extension, lazy-load on first recall use to keep startup snappy.

### Defuddle vs Readability
- **Defuddle status**: Active, MIT, by Kepano (Obsidian founder); 0.6.x stable as of mid-2025. Built into Obsidian Web Clipper. HN consensus and the maintainer himself say Readability is "mostly abandoned" ([HN](https://news.ycombinator.com/item?id=44067409)).
- **Special features**: Site-specific extractors for ChatGPT/Claude/Gemini chat threads (in development per HN comments), standardized footnote/code/math output, schema.org metadata extraction, Mobile-style heuristics.
- **Service-worker compat**: HN reports Defuddle had issues running in extension service-worker contexts vs Readability ([HN](https://news.mcan.sh/item/44067409)) — workaround: run inside content script (DOM context) or offscreen document.
- **Recommendation**: **Defuddle as primary**, Readability fallback. Run extraction in content script or offscreen document.

### Chrome MV3 stability for the design
- **MV3 mandatory**: V2 deprecated, MV3 required for new submissions ([source](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)).
- **Service-worker lifecycle**: 30s idle timeout, 5min max for fetch; recent platform improvement: better control over service-worker lifetimes for long-running event listeners ([Chrome blog](https://developer.chrome.com/en/blog/resuming-the-transition-to-mv3)). Periodic trivial API call extends lifetime; Anthropic-style enterprise keep-alive officially documented.
- **Side Panel API**: Stable since Chrome 114 (April 2023), supported in MV3 with `side_panel.default_path`, programmatic open via `chrome.sidePanel.setPanelBehavior` ([source](https://www.stefanvd.net/blog/2023/05/06/how-to-create-a-sidebar-chrome-extension-mv3/)).
- **fetch/SSE interception**: Confirmed pattern is **MAIN-world content script at `document_start` overriding `window.fetch` and `XMLHttpRequest`** ([dev.to MV3 SSE guide](https://dev.to/wilow445/how-to-intercept-server-sent-events-in-chrome-extensions-mv3-guide-23kb)). webRequest blocking is gone, but observation via MAIN-world is not. **Caveat: Gemini routes some requests through service-worker contexts** that bypass `window.fetch` — may require `chrome.debugger` API for full coverage.
- **declarativeNetRequest**: Static rulesets raised from 10→50, total from 50→100 ([What's New in Chrome Extensions](https://developer.chrome.com/docs/extensions/whats-new)) — irrelevant for BAC's design but a positive signal.
- **Recommendation**: All BAC primitives are feasible on MV3. Plan for graceful fallback to clipboard mode when fetch interception breaks (chat UI redesigns); ship a selector-canary test on each chat-tab load.

### WXT vs Plasmo (Q1/Q2 2026)
- **Consensus winner: WXT.** Plasmo is in maintenance mode per WXT's own comparison and confirmed in community accounts; reliance on Parcel (slower, less compatible with modern packages); HMR unreliable for non-React content ([WXT compare](https://wxt.dev/guide/resources/compare), [Redreamality](https://redreamality.com/blog/the-2025-state-of-browser-extension-frameworks-a-comparative-analysis-of-plasmo-wxt-and-crxjs/), [ExtensionBooster 2026](https://extensionbooster.com/blog/best-chrome-extension-frameworks-compared/), [Jetwriter migration](https://jetwriter.ai/blog/migrate-plasmo-to-wxt)).
- **Bundle sizes**: WXT ~400KB vs Plasmo ~700–800KB on representative extensions; ~40–43% smaller.
- **CRXJS**: Project shows abandonment banner — avoid.
- **Recommendation: WXT**. Vite-based, Vue/React/Svelte/Solid first-class, MV2/MV3 dual support, better service-worker HMR.

---

## Part D — Goal 4 Deliverable: The Unified MVP Proposal

### The MVP, in one paragraph

**BAC v1 is a Chrome extension + Obsidian-vault adapter that gives a multi-provider AI power user a single panel showing every chat thread they have open across ChatGPT, Claude.ai, and Gemini, automatically remembers the last 3 weeks of research, and lets them dispatch any highlight to any provider with full provenance — all without burning their tokens, and with everything written as plain Markdown into their Obsidian vault.** It exposes that personal cross-provider research memory as an MCP server so Claude Code, Cursor, and Codex can query it. It ships RedactionPipeline as a default-on safety primitive.

### 1. Single-sentence value proposition (landing page)

> **"The switchboard for your AI tabs. See every thread across ChatGPT, Claude, and Gemini in one panel. Dispatch any highlight in one click. Remember the last three weeks of your research, in your Obsidian vault, on your machine."**

(Sub-line: *No tokens burned. No data uploaded. Open architecture: BAC's memory is an MCP server your coding agents can read.*)

### 2. The 5–7 MVP scenarios (S-numbers from the existing catalog)

I commit to **6 scenarios + 3 safety primitives + the MCP server**, sized aggressively for 8–12 weeks. The selection deliberately collapses three of the proposed spines: I take the **2 highest-leverage scenarios from each** of ChatGPT-Pro, Obsidian, and Claude-DR spines, drop the rest, and deliberately defer the fork-converge merge UX.

| # | Scenario | Spine origin | Why it's in MVP |
|---|---|---|---|
| 1 | **S1 / S78 / S101 — "Where was I?" thread + bucket dashboard** (collapsed: Claude-DR's S1, ChatGPT-Pro's S78 rehydrate, Obsidian's S101 Bases dashboard, all converge into a single Bases-rendered "Where Was I?" view written to vault) | All three spines | The **anchor scenario**. First-session wow. Side-panel shows live registry; Bases file in vault is the durable artifact. |
| 2 | **S25 — Highlight → multi-target dispatch** (with provenance footnote built in) | ChatGPT-Pro / Claude-DR | Hook scenario: instantly demonstrates the switchboard. Combined with S4 ("chat-turn-capture-with-provenance") so every dispatch is logged + cite-able. |
| 3 | **S27 — Calibrated-freshness recall (3-day–3-week déjà-vu on highlight)** | Claude-DR | The defensible **memory differentiator**. Triggers when a user highlights text that resembles something they've highlighted/asked in the last 3 weeks — surfaces prior thread + prior answer **before** they re-ask. |
| 4 | **S74 — Context Pack export** (bucket → portable Markdown bundle, signed event-log slice attached) | ChatGPT-Pro | The handoff format that turns BAC into a *system*, not a feature. |
| 5 | **S99 — Workstream-graph mirror to Obsidian frontmatter** (entities → YAML; minimal viable subset: Workstream, Bucket, Source, PromptRun, ContextEdge) | Obsidian | Makes vault canonical, makes BAC architecturally elegant, and unlocks Bases dashboards trivially. |
| 6 | **S62 — Dogfood loop slice: "open a note → fork to N chats with Context Pack → notify on completion → patch source note"** (single happy path, no merge UX) | ChatGPT-Pro | Ties everything together; the demo scenario for launch video. |
| **+P1** | **RedactionPipeline before any Inject** (API-key/PII regex set + user-extensible) | Safety | Ship-blocking. |
| **+P2** | **Selector canary on every chat-tab load + graceful clipboard fallback** | Safety | The thing that lets BAC survive a ChatGPT redesign on launch day. |
| **+P3** | **Screen-share-safe mode** (auto-detected via `navigator.mediaDevices.getDisplayMedia` permission state — masks bucket names + provenance footnotes) | Safety | Cheap, table-stakes for the ICP (lots of dev YouTube/streamers in target audience). |
| **+M** | **MCP server (WebSocket localhost) exposing event log + recall + workstream graph as read-only tools** | Architecture | The thing that makes BAC genuinely architecturally novel and immediately useful in Claude Code/Cursor/Codex. |

**Explicit deferrals from the reconciled v1 spine**:
- S100 Canvas DAG view → **v1.5** (cosmetic delight, not engagement-driving)
- S104 inbox + S105 open-in-Obsidian + S108 first-run polish → **v1.0.1** (post-launch)
- Fork-and-converge merge UX (S40/S56/S57) → **v1.5**
- Lifecycle state machine (S-state-machine) → **v1.5** (states are emergent from event log; explicit UI deferred)
- Auto-template extraction from prompt corpus (T3) → **v2**
- Local fine-tune (T4) → **never unless extreme demand**

### 3. Required primitives

| Primitive | MVP? | Notes |
|---|---|---|
| **Observe** (fetch/SSE interception, MAIN-world content script) | **Yes** | The substrate for thread registry, recall corpus, dispatch logging. ChatGPT, Claude.ai, Gemini selectors with canary tests. |
| **Inject** (programmatic prompt injection into chat textareas) | **Yes** | For dispatch. Reuse the long-known DOM-event pattern documented widely. |
| **Locate** (Hypothesis-anchoring on source pages; turn-IDs in chat threads) | **Yes** (turn-IDs); **partial** (Hypothesis-anchor for highlights — full anchoring deferred unless trivial via the BSD-2 modules) | Needed for cite-this-turn. |
| **Bucket** (Workstream/Bucket primitive in event log + frontmatter) | **Yes** | Minimal: name + parent + state. |
| **Event log** (append-only, signed, JSONL in vault `_BAC/events/`) | **Yes** | The canonical source of truth; everything else is rebuildable. |
| **Recall** (PGlite + pgvector + transformers.js MiniLM-L6-v2 WASM, lazy-loaded) | **Yes** | Calibrated to 3-day–3-week recency; older data still searchable but deprioritized in default rank. |
| **Relate** (workstream-graph entities + ContextEdges) | **Yes (minimal)** | 5 entity types in MVP (Workstream/Bucket/Source/PromptRun/ContextEdge); Claim/Decision/OQ/Assumption/FreshnessSignal in v1.5. |
| **MCP-bridge** (WebSocket localhost MCP server exposing read tools `bac.search`, `bac.recent_threads`, `bac.workstream`, `bac.context_pack`) | **Yes** | The architectural moat. Read-only in v1, write tools (e.g. `bac.append_decision`) deferred. |
| **Adapter interface** for chat providers and notebooks | **Yes** | Typed; required for "open architecture" pillar. |

### 4. Adapters required for MVP

- **Chat providers (Observe + Inject)**: ChatGPT (chatgpt.com), Claude.ai, Gemini. **Not in MVP**: Perplexity, Grok, Copilot — adapter scaffolding ready but adapters land in v1.0.1.
- **Notebook (Read + Write)**: Obsidian via Local REST API plugin (PATCH frontmatter, write Markdown, write `.base` for "Where Was I" dashboard).
- **Coding agent (MCP)**: Single MCP server endpoint, validated against Claude Code (`claude --chrome`-adjacent pattern), Cursor, Codex CLI. No coding-agent-specific adapter needed — MCP is the adapter.
- **Source extractor**: Defuddle (vendored, MIT) for arbitrary web pages.

### 5. The wow moment (~150 words, first-session story)

*Maya is a senior PM with five AI tabs open. She installs BAC. The side panel asks for her Obsidian vault path; she pastes the Local REST API key. BAC silently observes her open ChatGPT, Claude, and Gemini tabs and writes a `_BAC/Where-Was-I.base` file into her vault with three rows: "Pricing-experiment thread (ChatGPT, last reply 2h ago, you replied last)", "Auth-refactor research (Claude, awaiting your reply)", "Competitor scan (Gemini, stale 4 days — notebook updated since)." She opens the Obsidian Bases dashboard — it's just there. She highlights a paragraph in a Stripe doc and right-clicks → "Send to ChatGPT + Claude + Notebook". A footnote auto-attaches: `[bac-source: stripe.com/.../section-3, captured 14:32, redacted: 1 API key]`. Two minutes later, she highlights "ramp-up curve" on a competitor's page; BAC pops a quiet card: "You discussed this with Claude 6 days ago — open thread?" That's the moment.*

### 6. The moat — what's hard to copy in 6 months

| Competitor | What they could copy in 6 months | What they can't / won't |
|---|---|---|
| **Sider, MaxAI, Monica** | Highlight dispatch + multi-LLM panel — **already partially done** | Won't ship local-first / Obsidian-canonical (their business model is sidebar AI, not memory ledger); won't ship MCP-server-out (architectural shift). |
| **Mem0/OpenMemory, AI Context Flow, MemoryPlugin** | Cross-provider fact extraction — **already done**; "buckets" — done | Won't ship **Obsidian-canonical-projection + workstream-graph + Context Pack format + browser-fetch-observation underpinning** simultaneously; their cloud-storage architecture is structurally opposed to BAC's pillar. AI Context Flow is the closest threat — see §A. |
| **Supermemory / Nova consumer app** | Personal AI app with memory graph — done; Chrome extension feasible | Cloud-first DNA; will not pivot to local-first/Obsidian-canonical. |
| **ChatGPT Atlas** | Cross-tab memory inside ChatGPT family — already done | Cannot show your Claude/Gemini threads (not OpenAI's interest); cannot write to your Obsidian vault as canonical layer; won't expose user data via MCP. |
| **Claude in Chrome** | Browser automation, scheduled tasks — done; multi-tab context — done | Provider-locked; will not register or remember your ChatGPT/Gemini threads. |
| **Comet / Dia** | "Personal work memory" — Dia explicitly committed to this | Browser-replacement strategy = 12–18 months from feature parity for a multi-LLM thread registry; Dia is enterprise/Atlassian-tilted, not solo-power-user-tilted. |
| **Anthropic / OpenAI / Notion / Obsidian (first-party)** | Each could ship their slice | None has commercial incentive to ship cross-provider thread registry — every one of them benefits from lock-in. **This is the structural wedge.** |

**The composite moat**: cross-provider observation **+** local-first/Obsidian-canonical **+** MCP-server-out **+** workstream-graph entity model **+** Context Pack handoff format. **No competitor has all five.** Each one alone is copyable; the combination is not, because it requires standing on a *neutral, non-provider, file-format-respecting* perch — the exact perch a major incumbent will not take.

### 7. Explicit cuts from the reconciled v1 spine, with rationale

- **Canvas DAG (S100)** → cosmetic; Bases dashboard does the engagement work; revisit v1.5.
- **Lifecycle state machine UI (S-states)** → states emergent from event log; explicit UI is rejection-risky scope-creep.
- **Fork-and-converge merge UX (S40, S56, S57)** → the merge UX is what's hard; the dispatch is what's easy. Ship dispatch + side-by-side links in MVP, defer merge.
- **Auto-template extraction (T3) and local fine-tune (T4)** → unbounded ML scope; in-input autocomplete (T1) on prompt corpus is already a significant v1 lift.
- **Open Question / Claim / Assumption / Decision typed-saves (S100-class)** → nice but emergent; defer to v1.5 once event log is stable.
- **Notion adapter** → Obsidian-only in MVP; the pillar bet is Obsidian-canonical; Notion is a v1.5 sidegrade.
- **Coding-specific scenarios** → covered by MCP server; explicit IDE-side UX deferred.

### 8. Feasibility risks specific to this MVP, with mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Chat UI redesigns break selectors / fetch shape** | High (continuous) | High | (a) MAIN-world fetch interception is more durable than DOM scraping; (b) selector canary on every chat-tab load with telemetry-free local count; (c) graceful degrade to clipboard mode + "BAC paused on this site, [report broken]" UI. |
| **ChatGPT/Anthropic ToS challenge to fetch-interception observation** | Medium | High | Position as "user-side accessibility tooling reading the *user's own* session"; never automate sending or scrape across users; respect site permission toggles (BAC active site allowlist, default deny on auth/payment domains). Read [Atlas privacy + Anthropic Chrome extension precedent](https://www.anthropic.com/news/claude-for-chrome) — both companies have shipped tools that operate similarly with user consent, so the precedent is favorable. |
| **PGlite + Defuddle + transformers.js bundle size** | Medium | Medium | Lazy-load PGlite + transformers.js + EmbeddingGemma on first-recall use; ship a stub MiniLM ~25MB by default. WXT keeps base bundle small (~400KB) ([extensionbooster](https://extensionbooster.com/blog/best-chrome-extension-frameworks-compared/)). |
| **Obsidian Local REST API friction** (install, cert) | Medium | Medium | First-run wizard with fallback to filesystem-only mode (BAC writes via Native Messaging or downloads to vault folder if user declines plugin). Don't make REST API a hard dependency. |
| **Service-worker MCP server lifetime** | Medium | Medium | Run MCP server in a paired-down localhost native helper or use the `chrome.runtime` keep-alive pattern; treat the SW as MCP-tool-handler dispatcher, not the long-running socket. Real Browser MCP / mcp-chrome both ship working patterns. |
| **Prompt-injection via captured pages** | Medium | High | Taint-label all captured content; wrap in `<context>` markers in any dispatch; scrub patterns ("ignore previous instructions", system-role mimicry); explicit "execute-from-captured-content: never" rule. (Anthropic's red-teaming numbers — 11.2% post-defense success rate — are the canary; ship at least equivalent defenses.) |
| **MCP server abuse vector** | Low (local only) | Medium | Bind to 127.0.0.1, require API key, only expose **read** tools in v1, expose write tools only behind explicit user opt-in. |
| **Mem0 / AI Context Flow eats the category** | Medium-high | High | Differentiation message + Obsidian-power-user channel (those users will not adopt cloud-first). Move fast, ship MCP server early, lean on the architectural elegance pitch (open formats, signed event log). |

### 9. Launch surfaces (in order of priority)

1. **Obsidian community plugin marketplace + Obsidian Discord/forum** — single biggest leverage point because the Obsidian-canonical bet is the differentiator.
2. **Show HN** — "BAC: a local-first switchboard for ChatGPT/Claude/Gemini that remembers your research in your Obsidian vault, exposed as an MCP server" — strong HN-ICP fit.
3. **Chrome Web Store** — distribution, but secondary to the HN/Obsidian initial signal.
4. **r/ObsidianMD, r/LocalLLaMA, r/ChatGPTPro** — targeted technical sub-communities.
5. **MCP registry / `lobehub.com`** — register BAC's MCP server tool description so Claude Code/Cursor users discover it organically.
6. **dev YouTube** — Theo (t3.gg), Fireship-style video pitches "your AI tabs in one panel"; pay-for-placement only after #1–4 traction.
7. **X (Twitter) AI-power-user community** — Simon Willison, Kepano, Anthropic devrels, AI Engineer Summit crowd.

**Do not** launch on Product Hunt first — wrong audience for a local-first power-user tool.

### 10. Success metrics (local, opt-in only)

All metrics computed locally, surfaced in a "BAC Health" dashboard, with explicit opt-in to anonymized aggregate sharing.

| Horizon | Activation signal | Engagement signal | Memory signal | Retention signal |
|---|---|---|---|---|
| **Week 1** | First Where-Was-I.base auto-rendered (≥3 threads detected) | ≥1 highlight dispatch with provenance footnote | n/a (corpus too small for recall) | Returns to side panel ≥3 days |
| **Week 4** | ≥2 buckets/workstreams created | ≥10 dispatches/week; ≥5 with multi-target | First déjà-vu pop ("you asked this 9 days ago") fires; user clicks ≥1 | Daily-active 4/7 days; vault has ≥10 BAC-managed notes |
| **Week 12** | MCP server connected from ≥1 coding agent (Claude Code/Cursor) | Context Pack exported ≥1× | Recall hit rate (user-clicks-déjà-vu / déjà-vu-shown) ≥30% | Weekly-active 8/12 weeks; user has saved ≥1 Decision/Claim explicitly |

Anti-vanity: do not measure raw event-log size, captures count, or model token counts as success — those grow without value.

---

## Part E — Goal 5 Deliverable: Consolidated Document Outline

Section-by-section outline for the successor document. Subsumption notes show which old sections fold into each.

### §1. Product vision and three hard constraints (re-authored, post-addendum) {#1}
*Re-states the switchboard + memory ledger thesis; the three constraints (don't burn tokens, open architecture, privacy-first/local-first) with refinements absorbed: BYO-API for power features (long-thread auto-summary, prompt rewrite), MCP-as-host-and-server, Obsidian-as-canonical-projection, local-first with encrypted-blob escape valve.*
**Subsumes**: original §1 + storage-canonicality reconciliation from Addendum 4.

### §2. Storage canonicality decision (resolves the contradiction) {#2}
*Decision tree, in one page. **Event log JSONL in vault is canonical and signed**; **Obsidian frontmatter/Canvas/Bases are projections** (regenerable); **PGlite/IndexedDB outside the event log is a rebuildable cache**; **encrypted blobs to user-provided remote storage are an escape valve**, never canonical.*
**Subsumes**: Addendums 2, 3, 4 storage debates.

### §3. Workstream-graph entity model (the typed core) {#3}
*Workstream / Bucket / Artifact / Source / PromptRun / ThreadKnowledgeState / ContextEdge / Decision / OpenQuestion / Claim / Assumption / FreshnessSignal — definitions, YAML schemas, MVP subset (Workstream/Bucket/Source/PromptRun/ContextEdge).*
**Subsumes**: original §6 entity sketch + Addendum 3 typed-save buttons.

### §4. Context Pack: the universal handoff format {#4}
*Full schema (goal / decisions / source clips / prior AI outputs / open questions / code context / instructions for target). MIME, file layout, signing, redaction-status field.*
**Subsumes**: original §11 + Addendum 4 packaging discussion.

### §5. Lifecycle state machine (deferred to v1.5) {#5}
*States listed (inbox → exploring → waiting on AI → waiting on source → ready to decide → decided → handed to coding agent → implemented + archived/resurfaced). Decision: **emergent from event log in v1**, explicit UI v1.5.*
**Subsumes**: Addendum 4 lifecycle + state-machine debate.

### §6. The three pillar workflows (W1, W2, W3) — final framing {#6}
*W1 cross-AI orchestration; W2 reading capture; W3 calibrated-freshness recall (REFRAMED from "long-term memory", weighted to 3-day–3-week recency). Each pillar lists its core scenarios and v1/v1.5/v2 disposition.*
**Subsumes**: original §3.

### §7. Canonical scenario catalog (35–45 collapsed from 151) {#7}
*Subsumption graph. Each canonical behavior has: ID, name, pillar, primitives required, tier (v1/v1.5/v2/parking), and "subsumes: [old S-numbers]". Examples: **CB-01 "Where was I"** subsumes S1 + S78 + S101 + S104; **CB-08 "Fork dispatch with provenance"** subsumes S25 + S40 + S56 + S57 (merge UX); **CB-12 "Déjà-vu recall"** subsumes S27 + S62 (recall slice) + S74 (deja-vu attached to Context Pack); etc.*
**Subsumes**: original §4 (148 scenarios) + Addendum 1 (S78) + Addendum 2 (S99–S108) + Addendum 5 additions.

### §8. Architecture — primitives layer {#8}
*Observe / Inject / Locate / Bucket / Event log / Recall / Relate / MCP-bridge. Each with interface contract, MVP/deferred status, and dependency notes.*
**Subsumes**: original §5 + Addendum 3 primitives.

### §9. Architecture — adapters layer {#9}
*Adapter interface contract; chat-provider adapters (ChatGPT, Claude.ai, Gemini for MVP); notebook adapter (Obsidian Local REST API); source-extractor adapter (Defuddle); MCP-bridge adapter. Each adapter doubles as an MCP server where natural.*
**Subsumes**: original §7 + Addendum 4 MCP-as-host-and-server section.

### §10. MCP-as-host-and-server: the integration shape {#10}
*BAC hosts MCP servers (filesystem, GitHub, Linear, Sentry, etc.) the user adds; BAC exposes its own event-log/recall/workstream-graph as a localhost WebSocket MCP server consumed by Claude Code, Cursor, Codex. Tool inventory for v1 (read-only): `bac.search`, `bac.recent_threads`, `bac.workstream`, `bac.context_pack`, `bac.deja_vu`. v1.5 write tools sketched.*
**Subsumes**: Addendum 4 MCP architecture.

### §11. Obsidian as canonical projection layer {#11}
*Vault layout (`_BAC/events/`, `_BAC/workstreams/`, `_BAC/where-was-i.base`, `_BAC/canvas/`); YAML frontmatter conventions; Canvas write contract; Bases dashboards for "Where was I", "Open questions", "Stale threads"; Local REST API integration; first-run wizard; fallback path when REST API unavailable.*
**Subsumes**: Addendum 2 (Obsidian-canonical) + Addendum 5 vault-layout.

### §12. Safety primitives (ship-blocking) {#12}
*RedactionPipeline before Inject; token-budget warnings; prompt-injection defense (taint label, `<context>` markers, scrub patterns); cite-this-chat-turn provenance footnote spec; screen-share-safe mode auto-detect; deny-list for auth/payment domains; selector canary + clipboard fallback contract.*
**Subsumes**: Addendum 4 safety section + Addendum 5 primitives.

### §13. Technical substrate decisions (final library choices, with v1/v1.5 splits) {#13}
*WXT (over Plasmo); Defuddle (over Readability); Hypothesis client modules (BSD-2) for anchoring; PGlite + pgvector + HNSW for recall; transformers.js v4 + WebGPU + MiniLM-L6-v2 (v1) / EmbeddingGemma-300M MRL@512 (opt-in upgrade); WebSocket localhost MCP server; MAIN-world content script for fetch/SSE interception; offscreen documents for clipboard; coddingtonbear's Obsidian Local REST API (with `obsidian-cli-rest` as monitor-only alternative).*
**Subsumes**: Addendum 5 library audit + open questions §17.

### §14. Prompt corpus tiers (T1 in v1; T2 v1.5; T3 v2; T4 parking) {#14}
*Every dispatch logs a PromptRun; T1 in-input autocomplete on the corpus; T2 semantic similarity recall; T3 auto-template extraction; T4 local fine-tune.*
**Subsumes**: original §10 + Addendum 4 corpus tier discussion.

### §15. The committed v1 spine and tiered roadmap {#15}
*The 6 canonical scenarios + 3 safety primitives + MCP server (from Part D §2). v1.5 list. v2 list. Parking lot. Explicit "rejected — won't ship" list with rationale. Maps each item to canonical-behavior IDs from §7.*
**Subsumes**: Addendum 4 three v1 spines (resolves the contradiction).

### §16. ICP, positioning, landing-page framing, launch surfaces, success metrics {#16}
*Primary ICP (multi-provider AI power user); secondary (solo dev + coding-agent user); tertiary (researcher/academic, knowledge worker/consultant). Final landing tagline. Launch sequence (Obsidian community → HN → Chrome Web Store → MCP registry → dev YouTube). Local-only, opt-in success metrics for week 1/4/12.*
**Subsumes**: original §13 + Addendum 4 positioning + Goal 4 deliverables.

### §17. Audit trail and provenance ledger for the document itself {#17}
*Every claim in the consolidated doc is annotated with its source addendum/research artifact, so future contributors can trace reasoning. Tagged spans (e.g., `[from-§4-original]`, `[from-A2]`, `[from-research-2026-04]`). Open-questions log with current best-answer + last-updated-date.*
**Subsumes**: original §17 + Addendum 4 unresolved items.

### §18. (Optional) Competitive landscape snapshot — refreshable {#18}
*Pinned Apr-2026 competitor table from this document's Part A as a versioned snapshot, with a "review on" date and rationale for each "threat / complementary / non-threat" classification. Designed to be re-run quarterly.*
**Subsumes**: original §15 (competitor scan) + this research pass.

---

## Executive Summary — 5 Bullets on the Consolidation Work Needed Before PRD

1. **The category got crowded fast — and the BAC differentiation is now a *combination*, not a feature.** ChatGPT Atlas and Claude in Chrome own the in-browser-agent surface. Mem0/OpenMemory, AI Context Flow, MemoryPlugin, and Supermemory own the cross-provider-personal-memory surface. Dia (Atlassian) owns the future-of-work-browser surface. **None has all of: cross-provider observation + local-first + Obsidian-canonical + MCP-server-out + workstream-graph + Context Pack handoff.** That five-way intersection is BAC's only durable moat, and the consolidated PRD must explicitly defend each of the five against eat-the-category pressure from the closest single competitor (AI Context Flow). Resolve the document's three-spine contradiction by committing to a **6-scenario + 3-safety-primitive + MCP-server v1** that touches all five intersection axes from session one.

2. **Resolve storage canonicality immediately, in one page, before anything else.** The document has contradictory takes across addendums. The right answer is **event-log-JSONL-in-vault is canonical-and-signed; frontmatter/Canvas/Bases are projections; IndexedDB/PGlite is a rebuildable cache; encrypted-remote is an escape valve**. Every other architectural decision flows from this; ambiguity here is the single biggest risk to the brainstorm-to-PRD bridge.

3. **Collapse the 151 scenarios to ~35–45 canonical behaviors, with an explicit subsumption graph, and pick the 6 that ship in v1.** The "S1/S78/S101 are three views of one behavior" pattern repeats throughout the catalog. The committed v1 spine (CB-01 Where-was-I + CB-08 Fork-dispatch-with-provenance + CB-12 Déjà-vu-recall + CB-15 Context-Pack-export + CB-22 Frontmatter-mirror + CB-30 Dogfood-loop-slice, plus three safety primitives and the MCP server) is the right shape. Lifecycle-state-machine UI, Canvas DAG view, fork-converge merge UX, and typed Claim/Decision/OQ saves should all be explicitly tagged v1.5 — not "in MVP if time permits". Scope honesty here is what makes the 8–12 week target real.

4. **The technical substrate is more ready in 2026 than the brainstorm assumes.** Confirmed-production-ready: WXT (over Plasmo, ~40% smaller bundles, active maintenance — [WXT compare](https://wxt.dev/guide/resources/compare)); PGlite v0.4 with pgvector ([Mar 2026](https://electric-sql.com/blog/2026/03/25/announcing-pglite-v04)); transformers.js v4 with WebGPU and EmbeddingGemma-300M ([HF v4](https://github.com/huggingface/transformers.js/releases/tag/4.0.0)); Obsidian Local REST API at 355k downloads and stable; JSON Canvas spec 1.0 with MIT external-tool clearance; Bases public spec since Obsidian 1.9; Defuddle (Kepano) maintained MIT replacement for the abandoned Readability. **The only meaningful technical risks left are**: (a) Gemini's service-worker-routed requests bypassing MAIN-world fetch override (need `chrome.debugger` fallback), (b) selector-canary breakage on chat UI redesigns (graceful degrade to clipboard mode), and (c) MCP server lifetime within MV3 service workers (paired-down localhost native helper or carefully managed keep-alive). Open question §17 items can mostly be **closed** with current evidence.

5. **The launch sequence and success metrics need explicit re-authoring before the PRD locks.** The brainstorm under-emphasizes distribution. Obsidian community plugin marketplace + Show HN are the highest-leverage v1 launch surfaces — far more than Chrome Web Store organic. Success metrics should be local, opt-in, and explicitly tied to the *memory* and *MCP-bridge* differentiators (déjà-vu click-through rate; coding-agent connect rate; Context-Pack exports), **not** raw capture/event counts which grow without value. Anti-vanity instrumentation discipline is a brainstorm-to-PRD-bridge requirement, not an after-the-fact optimization.