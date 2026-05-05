# Browser Extension Message Contract: sidetrack.annotation.publishToChat

## Summary

Publishes a side-panel turn annotation into the live provider chat. The side panel sends the request after the user clicks "publish to chat" from the turn annotation composer. The background script finds the already-open chat tab by canonical thread URL, focuses it, and relays the generated annotation message through the existing content-script auto-send driver.

## Message metadata

- Type: `sidetrack.annotation.publishToChat`
- Version: v1
- Source: side panel
- Target: background, then content script in the matched chat tab
- Request/response: yes

## Payload schema

```json
{
  "type": "sidetrack.annotation.publishToChat",
  "threadUrl": "https://chatgpt.com/c/example",
  "turnText": "Captured turn body",
  "turnRole": "assistant",
  "anchorText": "Optional exact keyword or quote highlighted on the page",
  "note": "Annotation note to publish",
  "capturedAt": "2026-05-05T00:00:00.000Z"
}
```

`anchorText` is optional. When present, Sidetrack also uses it as the visual annotation target for the live-page marker/highlight and includes it in the published chat message as the keyword or quote being explained.

## Response schema

```json
{
  "ok": true
}
```

On failure:

```json
{
  "ok": false,
  "error": "Open the chat tab in this window first - Sidetrack needs a live composer."
}
```

## Permission requirements

Uses existing extension tab and host permissions. No new Chrome permission is required.

## Security considerations

- Origin/source validation: the request is only accepted through the typed runtime message validator. Background selects the destination tab by canonical `threadUrl`.
- Sensitive data: the note and quoted turn are user-authored/local captured content. They are sent to the provider chat only after an explicit side-panel click.
- Redaction: no automatic redaction is applied in this UI path; the user is publishing directly into an open chat they control.

## Timeout/retry behavior

The content script uses the existing provider auto-send driver in submit-only mode. It waits for the composer to exist, inserts the generated annotation message, submits it, and returns immediately after submit instead of waiting for the provider's assistant response to finish. If the composer is missing or the provider is still responding to a previous message, the response returns `ok: false` with a user-visible error.

## Handler registration

- Validator: `packages/sidetrack-extension/src/messages.ts`
- Background handler: `packages/sidetrack-extension/entrypoints/background.ts`
- Provider send driver: `packages/sidetrack-extension/entrypoints/content.ts`
- UI caller: `packages/sidetrack-extension/entrypoints/sidepanel/App.tsx`

## Tests

- [x] Schema accepts valid payload via `isRuntimeRequest`
- [x] Schema rejects missing typed fields via `isRuntimeRequest`
- [x] Typecheck covers the message and response shapes
- [x] Build covers handler registration and content-script wiring
- [x] Browser e2e covers keyword-targeted annotation highlights on a ChatGPT-shaped page
