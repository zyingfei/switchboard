# Switchboard - Claude to Codex Workflow

- Provider: ChatGPT
- Captured at: 2026-04-25T23:10:02.644Z
- URL: https://chatgpt.com/g/g-p-69ec077b42948191a1fd309d64a860ae/c/69ed0307-46ec-8327-8423-199da5d88adb
- Selector canary: passed
- Extraction config: 2026-04-25-chatgpt-v3

## ChatGPT 1 - user

Uploaded image

i have design as implmented by claude design, can i download the artifacts and bring all of them to Codex?

## ChatGPT 2 - assistant

Yes — that is a good workflow: **Claude Design/Artifacts for visual exploration → Codex for turning it into a real repo, build, tests, and PR.**

Claude artifacts are meant to be reusable standalone outputs like code snippets, single-page HTML, diagrams, and React components, and Claude-created files can be downloaded from the conversation when file creation is used. [Claude Help Center+1](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) Codex can then work either **locally** through the Codex CLI, where it can read/edit/run code in your current directory, or **in cloud** after you connect a GitHub repo. [OpenAI Developers+1](https://developers.openai.com/codex/cli)

### Best handoff path

1.
  **Export everything from Claude**
    -
      Keep the exact file tree:
          -
            `extras.jsx`
          -
            `flyout.jsx`
          -
            `mcp.jsx`
          -
            `preflight.jsx`
          -
            `side-panel.jsx`
          -
            `vault.jsx`
          -
            `wizard.jsx`
          -
            `app.jsx`
          -
            `shared.jsx`
          -
            `tweaks-panel.jsx`
          -
            `design-canvas.jsx`
          -
            `styles.css`
          -
            `SwitchBoard Templates.html`
          -
            `uploads/`
    -
      Also save the screenshot / design preview as `docs/design-reference.png`.
    -
      Add a short `DESIGN_INTENT.md` explaining the expected demo flow.
2.
  **Create a repo**
  ```overflow-visible
  Bash
  mkdir
  switchboard-design-poc
  cd
  switchboard-design-poc
  git
  init
  ```
3.
  **Put Claude’s files under a raw import folder first**
  ```overflow-visible
  Bash
  mkdir
  -p
  design/claude-export
  # copy all downloaded files into design/claude-export
  ```
4.
  **Ask Codex to convert it into a runnable app**
  
  Locally:
  ```overflow-visible
  Bash
  npm
  i
  -g
  @openai/codex
  codex
  ```
  Or push to GitHub and use Codex Web. Codex Web works with connected GitHub repos and can create pull requests from its work. [OpenAI Developers+1](https://developers.openai.com/codex/cloud)

### Prompt I’d give Codex

```overflow-visible
This repo contains a Claude Design export under design/claude-export.
Goal:
Turn the exported design into a runnable, maintainable React/Vite app without changing the visual intent.
Constraints:
- Preserve the current SwitchBoard demo UX and layout.
- Treat design/claude-export as raw imported source of truth.
- Create a clean src/ structure.
- Wire app.jsx, shared.jsx, design-canvas.jsx, side-panel.jsx, flyout.jsx, preflight.jsx, vault.jsx, wizard.jsx, mcp.jsx, extras.jsx, tweaks-panel.jsx, and styles.css into a working app.
- Include any missing package.json dependencies.
- Do not over-refactor or redesign.
- Add README instructions for install, dev, build, and preview.
- Add at least one smoke test or build validation.
- Run npm install, npm run build, and fix build errors.
- If files are ambiguous, document assumptions in docs/import-notes.md.
```

### My recommendation

Use **Codex CLI first** for this because the code is not yet repo-shaped. Once Codex makes it build cleanly, commit it, push to GitHub, then use **Codex Web / PR review** for iteration. Codex also supports repo guidance via `AGENTS.md`, and its GitHub integration can review PRs with `@codex review`. [OpenAI Developers](https://developers.openai.com/codex/integrations/github)

I would not paste only the artifact link into Codex. Bring the **actual source files, assets, screenshot, and design intent**. The link is useful as reference, but the repo files are what Codex can reliably build, test, and refactor.
