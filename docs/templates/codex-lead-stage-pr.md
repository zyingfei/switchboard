# Codex + lead PR template (multi-wave stage PRs)

Use this template for PRs that ship a **multi-sub-task stage** through the
Codex-and-lead collaboration model — Stage 1 MVP (PR #99), Stage 2/3 work
graph (PR #105), and any future Stage N+ PRs.

The template is two things at once:

1. **A PR-body skeleton** that doubles as the work board (Codex pulls from
   it; lead verifies against it).
2. **An operational protocol** that tells Codex *and* lead how to interact
   without drowning each other's context in stale state.

Both come from real practice on PRs #99 and #105. Adopt as-is for Stage N+
PRs; clone + adjust for Wave count + sub-task count.

---

## Section 1 — PR body skeleton (paste into the PR description)

```markdown
## Summary

<1-2 sentence problem-statement + design north-star>

## Architectural locks (carry forward)

- Lock 1: <invariant>
- Lock 2: <invariant>
- Lock 3: <invariant>
- Lock 4: <invariant>

## Scope (locked YYYY-MM-DD)

| Item | Status |
|---|---|
| <Stage X canonical sub-task block> | ✓ in scope |
| <Future-stage candidates>          | ✓ / ✗ deferred (per user direction) |

Detailed briefs: [`docs/proposals/<plan-doc>-briefs.md`](...).
Each brief is self-contained — schemas, file paths, change shapes, test
scenarios, fixtures, copy-paste verification commands.

## Codex task list (Codex pulls; marks `[x]` on complete)

### Wave A — foundational (parallel)

- [ ] **S<n>** <one-line description>
- [ ] **S<n>** <one-line description>
- [ ] **F<n>** <one-line description>

### Wave B — depends on Wave A (parallel)

- [ ] **S<n>** <one-line description>

### Wave C — depends on Wave B (parallel)

- [ ] **S<n>** <one-line description>

### Wave D — sequential, lead-led

- [ ] **L<n>** <e2e suite / docs / lead-only sub-task>
- [ ] **S<n>** <UI surface depending on prior subs; explicitly lead-led>

## Codex hand-off protocol

1. Pull a brief from the briefs doc matching an unchecked Codex-owned box.
2. Create worktree on branch `codex/<stage>-<id>-<slug>` off the PR head.
3. Execute, run targeted tests, push.
4. **Mark the box `[x]` in this PR body when complete.** This PR's body is
   the source of truth for completion.
5. Lead reviews diff + integrates conflicts in shared files at merge time.

Multiple boxes can be checked in parallel within a wave. The lead's monitor
watches for new commits + new `[x]` marks and runs verification at each
landing.

## Test plan

- [ ] Wave A unit suites green (companion + extension)
- [ ] Wave B unit suites green
- [ ] Wave C unit suites green
- [ ] L1 e2e (`tests/e2e/<spec>.spec.ts`) passes
- [ ] No regression on prior-stage unit + e2e suites
- [ ] `./scripts/verify-standards.sh` green
- [ ] Bundle size delta from new deps documented
```

---

## Section 2 — Codex operational protocol

This is the **practical flow Codex follows for every dispatch**. Drilled
from Stage 2/3 (PR #105) practice; refined into a checklist a future Codex
can run without re-deriving the rules.

### Practical flow

1. **Poll PR state before any operation.**
   ```sh
   gh pr view <PR> --json body,state,isDraft,mergedAt,headRefOid > /tmp/pr-view.json
   gh pr diff <PR> --name-only > /tmp/pr-diff-names.txt
   gh pr diff <PR> > /tmp/pr-diff.patch
   ```
   Compare against last-known via shasum / md5sum:
   - PR JSON hash changed → board / comments / head likely changed.
   - name-only hash changed → file set changed.
   - full diff hash changed → patch changed.

   Inspect the full diff **only when the diff hash changed**. Avoids
   dumping a 100k-token patch into context every poll.

2. **Treat the PR body as the work board.**
   - Pick only **unchecked Codex-owned items in the current wave**.
   - Respect dependency notes + wave ownership.
   - If the PR says "lead-led," do not opportunistically start it.

3. **Work in isolated task worktrees / branches.**
   - Branch name: `codex/<stage>-<sub-task-id>-<slug>` (matches the brief).
   - One branch per board item; independently reviewable.

4. **Verify before publishing.**
   - Targeted tests for the touched area only (not the full suite).
   - `tsc --noEmit`.
   - ESLint + prettier where relevant.
   - `git status` to confirm only intended files staged.

5. **Push first, then mark the board.**
   - Do NOT check the PR box until the branch is pushed and the
     implementation exists remotely.
   - **Poll the PR again immediately before editing the body** —
     someone else may have edited it concurrently.

6. **After marking done, keep polling for lead integration.**
   - Watch PR head SHA, comments, reviews, checklist hash, file-list hash.
   - Polling cadence: 30-120 s during active integration windows;
     5-10 min during idle.
   - Stop when the lead's status comment confirms integration, or when no
     Codex-owned work remains.

### Best practices

- **Use the PR as the source of truth, not memory.** Reload the board on
  every iteration. Don't infer state from your own previous run.
- **Preserve lead ownership.** Lead-led items wait for the lead.
- **Keep task branches narrow** and named after the board item — one
  reviewable diff per item.
- **Stage only explicit paths.** Never `git add -A` in a mixed repo.
- **Commit follow-up fixes separately** instead of amending after another
  process may have seen the branch.
- **Poll before writes** — pushes, PR body edits, comments, or starting a
  new task. Always.
- **Use lead comments as operational instructions**, especially after
  integrations. They carry "what's now safe to start next."

### Context-saving optimization (the big efficiency win)

```sh
# Stage every fetch to /tmp keyed by PR + iteration:
GH_DIR=/tmp/codex-stage-poll/pr-<n>-<iter>
mkdir -p "$GH_DIR"

gh pr view <PR> --json body,state,isDraft,mergedAt,headRefOid > "$GH_DIR/pr-view.json"
gh pr diff <PR> --name-only > "$GH_DIR/pr-diff-names.txt"
gh pr diff <PR> > "$GH_DIR/pr-diff.patch"

# Compare hashes against the previous iteration:
for f in pr-view.json pr-diff-names.txt pr-diff.patch; do
  shasum -a 256 "$GH_DIR/$f" >> "$GH_DIR/hashes.txt"
done
```

Read the full patch into model context **only** when the patch hash
changes. Read the JSON body when the JSON hash changes. Otherwise short-
circuit with the cached previous read.

### What to avoid

- Starting work from an old PR body.
- Marking boxes before pushing.
- Assuming checked boxes mean integrated. Wait for lead comment or PR
  head movement.
- Reading the entire diff into model context every poll.
- Starting later-wave or sequential work without explicit permission.
- Reverting or cleaning unrelated dirty files.
- Running destructive git commands to "tidy up" (`git reset --hard`,
  `git clean -fd`, force-push, branch deletion).
- Treating tests as the only proof of completion. Map the brief to actual
  implementation + PR state.

### What can be avoided (efficiency)

- Re-reading unchanged full diffs.
- Re-running expensive full suites when no relevant files changed and
  targeted verification already passed.
- Re-polling too fast — 30-120 s is enough during active integration
  windows; 5-10 min during idle waits.
- Manual checklist edits without exact-line validation
  (`gh pr view --json body` + diff).
- Large status dumps in chat. Short summaries + `/tmp` artifacts beat
  raw paste-dumps.

---

## Section 3 — Lead operational protocol

The lead's role is the mirror image of Codex's:

### Practical flow

1. **Author detailed sub-task briefs** in
   `docs/proposals/<plan-doc>-briefs.md` BEFORE Codex spins. Briefs include
   schemas, file paths, change shapes, test scenarios, fixtures, copy-paste
   verification commands.
2. **Watch the PR via a self-paced wakeup loop** (10-min cadence during
   active integration; reduce to idle when nothing's happening).
3. **For each newly-checked Codex box + pushed branch**:
   - Pull the latest base.
   - `git merge --no-ff origin/codex/<branch>` with a clear "Integrate
     S<n>: ..." commit message.
   - Resolve conflicts in shared files (the convergence-point list lives
     in the brief; usually `snapshot.ts`, `types.ts`, materializer
     pipelines, side-panel routing).
   - Run companion + extension vitest + wxt build (touched packages only
     on first pass; full suite at wave boundary).
   - Push.
   - Post a status comment to the PR summarizing what landed + what's
     remaining + what's next to dispatch.
4. **At each wave boundary**: confirm previous-wave tests + dispatch the
   next wave's brief pointers in a comment.
5. **Lead-only items (Wave D)**: author after the prior waves land. e2e
   spec + docs updates + UI components requiring multiple Codex outputs as
   inputs (e.g., a Producer-pin UI that depends on multiple Class E
   revisions being live).

### Best practices

- **One PR per stage**, multiple Codex commits per wave inside it.
- **Each Codex sub-task = one independent merge commit**. No squashing
  during integration; the merge log is the audit trail.
- **Status comments are operational instructions** for Codex. They
  announce what's now safe to start next, where shared-file conflicts
  resolved, and what tests passed.
- **Trust but verify** — Codex's box check means "code pushed"; lead's
  integration means "tests pass + merged into integration branch."
- **Don't relitigate scope** mid-implementation. Scope was locked at
  briefing time; new items go to a follow-up PR.

### Status-comment template (lead → PR)

```markdown
**Wave <X> [partial|complete] integrated by lead at `<sha>`**

<N> Codex side-branches merged:

- `<sha>` Integrate S<n>: <one-line>
- ...

[Conflict resolution at integration time — none / details]

**Tests at the integrated tip:**
- companion vitest: <pass>/<total> (<files> files; +<new> new from this wave)
- extension vitest: <pass>/<total> (<files> files)
- `wxt build`: clean (<size>; +<delta> from <change>)

**<Wave X+1> [unblocked|in flight]:** <list>

Codex orchestrator: <next dispatch hint>.

🤖 Posted by [Claude Code](https://claude.com/claude-code) lead-monitor.
```

---

## Section 4 — File layout convention

```
docs/proposals/<plan-doc>.md             # the plan + scope-lock + wave structure
docs/proposals/<plan-doc>-briefs.md      # per-sub-task self-contained briefs
docs/architecture.md                     # evergreen architecture (extends each stage)
docs/timeline.md                         # surface-specific docs (extends each stage)
docs/templates/codex-lead-stage-pr.md    # this file
```

The plan + briefs land BEFORE Codex spins. The PR body references the
briefs by anchor (`docs/proposals/<plan-doc>-briefs.md § <id>`).

---

## Section 5 — Stop conditions

A monitor / loop ends when ANY of:

- The PR is merged (`mergedAt` non-null).
- The user says "stop monitoring" (or equivalent).
- The branch is deleted (post-merge cleanup).
- All board items are checked AND the lead has posted the
  Wave-D-complete status comment.

A lead's wakeup-driven monitor reschedules itself ONLY when none of the
above is true.

---

## Why this template exists

PR #99 (Stage 1 MVP) and PR #105 (Stage 2/3 work graph) shipped
~17 + ~17 sub-tasks each across 4 waves with parallel Codex execution and
serialized lead integration. The pattern works — but only because both
sides agree on the protocol, the work board, and the polling discipline.

This template is what we'd hand a future Codex + lead pair on Stage N+ so
they don't have to re-derive any of it. Keep it short, keep it
operational, keep it grounded in what actually happened.
