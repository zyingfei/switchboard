# Obsidian Integration POC

This POC proves the thin Obsidian integration slice for Browser AI Companion:

```text
first-run connection -> Local REST API CRUD -> PATCH frontmatter -> PATCH heading
-> bac_id scan after move/rename -> .canvas + .base artifacts -> dashboard query
```

The planning branch's recommended thin slice is accepted as this build scope. The choices for this iteration are:

- Folder name stays `poc/obsidian-integration`.
- CI/e2e uses a fixture Obsidian Local REST API server, not a launched Obsidian UI.
- The side panel is a minimal endpoint/API-key runner, not a polished onboarding wizard.
- Captures are synthetic so Obsidian mechanics stay isolated from provider capture.
- Bases are assumed present; fallback design is deferred.

## What This Proves

- A Chrome MV3 extension can talk to an Obsidian Local REST API-compatible endpoint with bearer auth.
- BAC can create `_BAC/inbox/YYYY-MM-DD/<title>.md` capture notes.
- Frontmatter mirrors can hold `bac_id`, `bac_type`, `provider`, `source_url`, `status`, `project`, `topic`, `tags`, and `related` wikilinks.
- PATCH-frontmatter semantics can update individual properties without replacing the body.
- PATCH-heading semantics can append under `## Notes` without disturbing surrounding sections.
- `bac_id`-stable identity works after simulated rename/move because BAC scans frontmatter rather than trusting paths.
- User/frontmatter round-trip is represented by changing `topic` after the move and re-scanning it back into BAC state.
- `_BAC/dashboards/where-was-i.md`, `_BAC/dashboards/where-was-i.base`, and `_BAC/canvases/switchboard-map.canvas` are generated.
- Canvas output validates 16-character hex node IDs and `text`, `group`, and `file` node types.
- Bases output includes a table view filtered by BAC frontmatter.
- A Playwright extension e2e proves the side panel flow against the fixture REST server.

## What This Does Not Prove

- Real Obsidian UI rendering of `.canvas` or `.base` files.
- Real Local REST API plugin version compatibility across releases.
- The self-signed HTTPS certificate acceptance flow.
- Backlinks/Graph View behavior for `related:` frontmatter wikilinks.
- Bases live re-rendering inside the Obsidian app.
- Concurrent edits while the user is typing in Obsidian.
- Multi-vault behavior.
- Dataview or JsonLogic search.
- A production onboarding wizard.

Manual validation against real Obsidian is still required for the UI-rendering questions. The automated fixture proves the extension mechanics and file/API contracts without making CI depend on a desktop app.

## References

- Obsidian Local REST API plugin: https://github.com/coddingtonbear/obsidian-local-rest-api
- JSON Canvas file format: https://jsoncanvas.org/spec/1.0/
- Obsidian Bases syntax: https://obsidian.md/help/bases/syntax

## Run

```sh
cd poc/obsidian-integration
npm install
npm run compile
npm test
npm run build
```

Install Chrome for Testing once before e2e:

```sh
npm run e2e:install
npm run test:e2e
```

Useful e2e environment variables:

```sh
BAC_E2E_CHROME_PATH=/path/to/chrome npm run test:e2e
BAC_E2E_HEADLESS=1 npm run test:e2e
BAC_EXTENSION_PATH=/path/to/chrome-mv3 npm run test:e2e
```

## Try It Manually

Build the extension:

```sh
cd poc/obsidian-integration
npm install
npm run build
```

Load `.output/chrome-mv3` in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select `poc/obsidian-integration/.output/chrome-mv3`.
5. Open the extension side panel, or open `chrome-extension://<extension-id>/sidepanel.html`.

To test against a real vault:

1. Install and enable Obsidian Local REST API in Obsidian.
2. Use the insecure local endpoint `http://127.0.0.1:27123`, or trust the plugin's HTTPS certificate and use `https://127.0.0.1:27124`.
3. Copy the plugin API key.
4. In the POC side panel, enter the REST endpoint and API key.
5. Click `Connect`.
6. Click `Run thin slice`.
7. Open the generated files in Obsidian:
   - `Projects/SwitchBoard/MCP discussion.md`
   - `_BAC/dashboards/where-was-i.md`
   - `_BAC/dashboards/where-was-i.base`
   - `_BAC/canvases/switchboard-map.canvas`

The POC writes synthetic dogfood content into the configured vault. Use a temporary vault when validating manually.

If Obsidian returns `400`, the side panel now includes the Local REST API error detail. This POC intentionally sends exact `Content-Type` values (`text/markdown` and `application/json`) for PATCH requests because the real plugin rejects variants such as `text/markdown; charset=utf-8`.

## Test Coverage

Unit tests cover:

- frontmatter serialization, parsing, wikilink arrays, and single-key patching
- heading-target append behavior
- REST auth/header construction
- Canvas JSON shape and 16-character hex IDs
- Bases filter/table generation
- the full thin-slice vault sync workflow against an in-memory client

The Playwright e2e covers:

- launching the MV3 extension
- running the side panel against a fixture Obsidian REST server
- CRUD, frontmatter PATCH, heading PATCH, stable `bac_id` scan, round-trip topic scan
- generated `.canvas` and `.base` artifacts
- state persistence after side panel reload

## Project Map

```text
entrypoints/
  background.ts              MV3 background worker
  sidepanel.html             side panel HTML entry
  sidepanel/                 React side panel UI
src/
  background/                message router and coordinator
  obsidian/                  REST client, frontmatter, heading, vault sync, canvas, base builders
  shared/                    messages and time helpers
tests/
  unit/                      Vitest unit coverage
  e2e/                       Playwright extension test and fixture REST server
```

## Q1-Q10 Status

- Q1 PATCH-frontmatter: proven against the fixture contract and unit helpers; real plugin validation still manual.
- Q2 PATCH-heading: proven against the fixture contract and unit helpers; real plugin validation still manual.
- Q3 `bac_id` stable identity: proven by move/delete/write simulation plus frontmatter scan.
- Q4 Canvas rendering: JSON shape is validated; real Obsidian rendering remains manual.
- Q5 Bases filtering/reactivity: `.base` syntax is generated and fixture dashboard query updates; real Bases rendering/reactivity remains manual.
- Q6 Wikilink arrays: frontmatter array write/read is proven; Backlinks/Graph View behavior remains manual.
- Q7 First-run cost: represented by the minimal endpoint/API-key form; full install/cert/API-key journey remains manual.
- Q8 User frontmatter edit round-trip: represented by patching `topic` and scanning it back.
- Q9 Bundle/latency: build size and run latency are visible in command output and side panel; no optimization pass.
- Q10 Inbox UX: `_BAC/inbox/` write path is proven; 50+ item inbox feel remains dogfood/manual.
