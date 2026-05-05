# MCP Capability: bac.create_annotation

## Purpose

Create a persisted web annotation from a coding agent, scoped to an exact term
or short quote on the target page.

## Input

- `url: string` - exact page URL where the annotation should restore.
- `pageTitle: string` - current page title.
- `term: string` - exact term or short quote to highlight.
- `note: string` - annotation note.
- `prefix?: string` - surrounding text immediately before `term`, used to pick
  the right occurrence when a term repeats.
- `suffix?: string` - surrounding text immediately after `term`, used to pick
  the right occurrence when a term repeats.

## Output

Returns `{ annotation, term, createdAt }`. `annotation` is the companion
annotation record returned by `POST /v1/annotations`.

## Notes

The tool builds the same `TextQuote` anchor that the extension restores in the
content script. Prefix and suffix are capped to the extension's 32-character
context window so MCP-created highlights match browser-created highlights.
Position and selector fallbacks are intentionally disabled for this tool: if
the term/context cannot be found, the extension should leave the page unmarked
instead of highlighting the wrong section.
