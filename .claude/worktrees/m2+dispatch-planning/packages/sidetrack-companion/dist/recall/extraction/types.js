// Sync Contract v1 / Class E — versioned extraction revisions.
//
// The extraction layer sits between the immutable capture event log
// and downstream consumers (recall, context-pack, Obsidian, MCP,
// future summaries). Each `sourceUnitId` is a stable identity for
// one ChatGPT/Claude/Gemini turn (or future provider unit). Multiple
// extraction revisions can coexist for the same source unit;
// active-revision policy picks one canonical revision; recall is a
// CONSUMER of the active revision per source unit.
//
// Lane 2 lands the data model + extraction materializer + legacy
// capture wrap. Lane 2 follow-ups (manifest + planner + stored
// re-extract + capture.extraction.produced) are stages L2.S4..L2.S6.
// Canonical id minter. Prefer structured `turn:<provider>:<convo>:<msg>`
// when both ids are present; fall back to URL+role+ordinal+snapshotHash.
export const sourceUnitIdFor = (input) => {
    if (input.conversationId !== undefined &&
        input.messageId !== undefined &&
        input.conversationId.length > 0 &&
        input.messageId.length > 0) {
        return `turn:${input.provider}:${input.conversationId}:${input.messageId}`;
    }
    const url = input.canonicalUrl ?? '';
    const role = input.role ?? 'unknown';
    const ordinal = input.turnOrdinal ?? 0;
    const snap = input.sourceSnapshotHash ?? '';
    return `turn:${input.provider}:${url}:${role}:${String(ordinal)}:${snap}`;
};
//# sourceMappingURL=types.js.map