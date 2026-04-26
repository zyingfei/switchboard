# CLAUDE.md

Claude-specific operational notes for this repository.

The full repo conventions, engineering standards, and architectural
anchors live in [`AGENTS.md`](AGENTS.md). Read that first — it applies
to all coding agents (Claude Code, Cursor, Codex CLI, etc.).

## Claude-specific notes

- **Use `TaskCreate` / `TaskUpdate`** for any work spanning more than
  three steps. Mark tasks `in_progress` when starting and `completed`
  immediately when done.
- **Use the Explore subagent** for codebase exploration that needs
  more than three queries; use direct `grep` / `find` for narrower
  searches.
- **Worktrees** for parallel branch work: `EnterWorktree` to start an
  isolated branch session; `ExitWorktree` with `action: "keep"` to
  preserve mid-session work.
- **Memory** lives at `~/.claude/projects/-Users-yingfei-Documents-playground/memory/`
  per the project's auto-memory policy. Update `MEMORY.md` index when
  adding new memory files; keep the index under 200 lines.

## Repo navigation shortcuts

- `BRAINSTORM-INDEX.md` — generated index of `BRAINSTORM.md` (run
  `scripts/build-brainstorm-index.sh` after editing the brainstorm).
- `poc/<name>/README.md` — post-build documentation for each completed
  PoC. Treat as evidence; do not promote PoC code to production
  without going through `CODING_STANDARDS.md` §"POC-to-product
  conversion rule."
- `AGENTS.md` — engineering standards and conventions (load-bearing).
- `CODING_STANDARDS.md` — non-negotiable code-quality bar.

## What overrides what

If guidance conflicts:

1. The user's explicit instruction (highest priority).
2. `BRAINSTORM.md` architectural anchors (§23.0, §24.5, §24.10, §27,
   §27.6, §28).
3. Repo conventions in `AGENTS.md`.
4. Generic engineering standards in `CODING_STANDARDS.md` and
   `standards/*.md`.

Higher-numbered items lose to lower-numbered ones.
