import { z } from 'zod';
export declare const serializedAnchorSchema: z.ZodObject<{
    textQuote: z.ZodObject<{
        exact: z.ZodString;
        prefix: z.ZodString;
        suffix: z.ZodString;
    }, z.core.$strip>;
    textPosition: z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
    }, z.core.$strip>;
    cssSelector: z.ZodString;
}, z.core.$strip>;
export declare const captureEventSchema: z.ZodObject<{
    provider: z.ZodEnum<{
        unknown: "unknown";
        chatgpt: "chatgpt";
        claude: "claude";
        gemini: "gemini";
        codex: "codex";
    }>;
    threadId: z.ZodOptional<z.ZodString>;
    threadUrl: z.ZodURL;
    title: z.ZodOptional<z.ZodString>;
    capturedAt: z.ZodISODateTime;
    selectorCanary: z.ZodOptional<z.ZodEnum<{
        failed: "failed";
        ok: "ok";
        warning: "warning";
    }>>;
    extractionConfigVersion: z.ZodOptional<z.ZodString>;
    visibleTextCharCount: z.ZodOptional<z.ZodNumber>;
    tabSnapshot: z.ZodOptional<z.ZodObject<{
        tabId: z.ZodOptional<z.ZodNumber>;
        windowId: z.ZodOptional<z.ZodNumber>;
        url: z.ZodURL;
        title: z.ZodString;
        favIconUrl: z.ZodOptional<z.ZodURL>;
        capturedAt: z.ZodISODateTime;
    }, z.core.$strip>>;
    warnings: z.ZodOptional<z.ZodArray<z.ZodObject<{
        code: z.ZodEnum<{
            possible_api_key: "possible_api_key";
            email: "email";
            internal_url: "internal_url";
            long_capture: "long_capture";
            unsupported_provider: "unsupported_provider";
        }>;
        message: z.ZodString;
        severity: z.ZodEnum<{
            info: "info";
            warning: "warning";
        }>;
    }, z.core.$strip>>>;
    turns: z.ZodArray<z.ZodObject<{
        role: z.ZodEnum<{
            user: "user";
            assistant: "assistant";
            system: "system";
            unknown: "unknown";
        }>;
        text: z.ZodString;
        formattedText: z.ZodOptional<z.ZodString>;
        ordinal: z.ZodNumber;
        capturedAt: z.ZodISODateTime;
        sourceSelector: z.ZodOptional<z.ZodString>;
        modelName: z.ZodOptional<z.ZodString>;
        markdown: z.ZodOptional<z.ZodString>;
        reasoning: z.ZodOptional<z.ZodString>;
        attachments: z.ZodOptional<z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                image: "image";
                upload: "upload";
                artifact: "artifact";
                tool: "tool";
            }>;
            url: z.ZodOptional<z.ZodString>;
            alt: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        researchReport: z.ZodOptional<z.ZodObject<{
            mode: z.ZodEnum<{
                unknown: "unknown";
                "deep-research": "deep-research";
                "gemini-deep-research": "gemini-deep-research";
            }>;
            citations: z.ZodOptional<z.ZodArray<z.ZodObject<{
                source: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            sections: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const threadUpsertSchema: z.ZodObject<{
    bac_id: z.ZodOptional<z.ZodString>;
    provider: z.ZodEnum<{
        unknown: "unknown";
        chatgpt: "chatgpt";
        claude: "claude";
        gemini: "gemini";
        codex: "codex";
    }>;
    threadId: z.ZodOptional<z.ZodString>;
    threadUrl: z.ZodURL;
    title: z.ZodString;
    lastSeenAt: z.ZodISODateTime;
    status: z.ZodOptional<z.ZodEnum<{
        removed: "removed";
        queued: "queued";
        active: "active";
        tracked: "tracked";
        needs_organize: "needs_organize";
        closed: "closed";
        restorable: "restorable";
        archived: "archived";
    }>>;
    primaryWorkstreamId: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    trackingMode: z.ZodOptional<z.ZodEnum<{
        removed: "removed";
        manual: "manual";
        auto: "auto";
        stopped: "stopped";
    }>>;
    tabSnapshot: z.ZodOptional<z.ZodObject<{
        tabId: z.ZodOptional<z.ZodNumber>;
        windowId: z.ZodOptional<z.ZodNumber>;
        url: z.ZodURL;
        title: z.ZodString;
        favIconUrl: z.ZodOptional<z.ZodURL>;
        capturedAt: z.ZodISODateTime;
    }, z.core.$strip>>;
    lastResearchMode: z.ZodOptional<z.ZodEnum<{
        unknown: "unknown";
        "deep-research": "deep-research";
        "gemini-deep-research": "gemini-deep-research";
    }>>;
}, z.core.$strip>;
export declare const workstreamCreateSchema: z.ZodObject<{
    title: z.ZodString;
    parentId: z.ZodOptional<z.ZodString>;
    privacy: z.ZodOptional<z.ZodEnum<{
        private: "private";
        shared: "shared";
        public: "public";
    }>>;
    screenShareSensitive: z.ZodOptional<z.ZodBoolean>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    children: z.ZodOptional<z.ZodArray<z.ZodString>>;
    checklist: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        checked: z.ZodBoolean;
        createdAt: z.ZodISODateTime;
        updatedAt: z.ZodISODateTime;
    }, z.core.$strip>>>;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const workstreamUpdateSchema: z.ZodObject<{
    revision: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    parentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    privacy: z.ZodOptional<z.ZodEnum<{
        private: "private";
        shared: "shared";
        public: "public";
    }>>;
    screenShareSensitive: z.ZodOptional<z.ZodBoolean>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    children: z.ZodOptional<z.ZodArray<z.ZodString>>;
    checklist: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        checked: z.ZodBoolean;
        createdAt: z.ZodISODateTime;
        updatedAt: z.ZodISODateTime;
    }, z.core.$strip>>>;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const queueCreateSchema: z.ZodObject<{
    text: z.ZodString;
    scope: z.ZodEnum<{
        workstream: "workstream";
        thread: "thread";
        global: "global";
    }>;
    targetId: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        pending: "pending";
        done: "done";
        dismissed: "dismissed";
    }>>;
}, z.core.$strip>;
export declare const reminderCreateSchema: z.ZodObject<{
    threadId: z.ZodString;
    provider: z.ZodEnum<{
        unknown: "unknown";
        chatgpt: "chatgpt";
        claude: "claude";
        gemini: "gemini";
        codex: "codex";
    }>;
    detectedAt: z.ZodISODateTime;
    status: z.ZodOptional<z.ZodEnum<{
        dismissed: "dismissed";
        new: "new";
        seen: "seen";
        relevant: "relevant";
    }>>;
}, z.core.$strip>;
export declare const reminderUpdateSchema: z.ZodObject<{
    revision: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        dismissed: "dismissed";
        new: "new";
        seen: "seen";
        relevant: "relevant";
    }>>;
}, z.core.$strip>;
declare const codingToolSchema: z.ZodEnum<{
    codex: "codex";
    claude_code: "claude_code";
    cursor: "cursor";
    other: "other";
}>;
export declare const codingAttachTokenCreateSchema: z.ZodObject<{
    workstreamId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const codingAttachTokenSchema: z.ZodObject<{
    token: z.ZodString;
    workstreamId: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strip>;
export declare const codingSessionRegisterSchema: z.ZodObject<{
    token: z.ZodString;
    tool: z.ZodEnum<{
        codex: "codex";
        claude_code: "claude_code";
        cursor: "cursor";
        other: "other";
    }>;
    cwd: z.ZodString;
    branch: z.ZodString;
    sessionId: z.ZodString;
    name: z.ZodString;
    resumeCommand: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const codingSessionSchema: z.ZodObject<{
    bac_id: z.ZodString;
    workstreamId: z.ZodOptional<z.ZodString>;
    tool: z.ZodEnum<{
        codex: "codex";
        claude_code: "claude_code";
        cursor: "cursor";
        other: "other";
    }>;
    cwd: z.ZodString;
    branch: z.ZodString;
    sessionId: z.ZodString;
    name: z.ZodString;
    resumeCommand: z.ZodOptional<z.ZodString>;
    attachedAt: z.ZodISODateTime;
    lastSeenAt: z.ZodISODateTime;
    status: z.ZodEnum<{
        attached: "attached";
        detached: "detached";
    }>;
}, z.core.$strip>;
export declare const codingSessionListQuerySchema: z.ZodObject<{
    token: z.ZodOptional<z.ZodString>;
    workstreamId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const dispatchEventSchema: z.ZodObject<{
    bac_id: z.ZodOptional<z.ZodString>;
    kind: z.ZodEnum<{
        other: "other";
        research: "research";
        review: "review";
        coding: "coding";
        note: "note";
    }>;
    target: z.ZodObject<{
        provider: z.ZodEnum<{
            chatgpt: "chatgpt";
            claude: "claude";
            gemini: "gemini";
            codex: "codex";
            claude_code: "claude_code";
            cursor: "cursor";
            other: "other";
        }>;
        mode: z.ZodEnum<{
            paste: "paste";
            "auto-send": "auto-send";
        }>;
    }, z.core.$strip>;
    sourceThreadId: z.ZodOptional<z.ZodString>;
    workstreamId: z.ZodOptional<z.ZodString>;
    title: z.ZodString;
    body: z.ZodString;
    createdAt: z.ZodOptional<z.ZodISODateTime>;
    redactionSummary: z.ZodOptional<z.ZodObject<{
        matched: z.ZodNumber;
        categories: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    tokenEstimate: z.ZodOptional<z.ZodNumber>;
    status: z.ZodDefault<z.ZodEnum<{
        queued: "queued";
        sent: "sent";
        replied: "replied";
        noted: "noted";
        pending: "pending";
        failed: "failed";
    }>>;
    mcpRequest: z.ZodOptional<z.ZodObject<{
        codingSessionId: z.ZodString;
        approval: z.ZodLiteral<"auto-approved">;
        requestedAt: z.ZodISODateTime;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const dispatchEventRecordSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        other: "other";
        research: "research";
        review: "review";
        coding: "coding";
        note: "note";
    }>;
    target: z.ZodObject<{
        provider: z.ZodEnum<{
            chatgpt: "chatgpt";
            claude: "claude";
            gemini: "gemini";
            codex: "codex";
            claude_code: "claude_code";
            cursor: "cursor";
            other: "other";
        }>;
        mode: z.ZodEnum<{
            paste: "paste";
            "auto-send": "auto-send";
        }>;
    }, z.core.$strip>;
    sourceThreadId: z.ZodOptional<z.ZodString>;
    workstreamId: z.ZodOptional<z.ZodString>;
    title: z.ZodString;
    body: z.ZodString;
    status: z.ZodDefault<z.ZodEnum<{
        queued: "queued";
        sent: "sent";
        replied: "replied";
        noted: "noted";
        pending: "pending";
        failed: "failed";
    }>>;
    mcpRequest: z.ZodOptional<z.ZodObject<{
        codingSessionId: z.ZodString;
        approval: z.ZodLiteral<"auto-approved">;
        requestedAt: z.ZodISODateTime;
    }, z.core.$strip>>;
    bac_id: z.ZodString;
    createdAt: z.ZodISODateTime;
    redactionSummary: z.ZodObject<{
        matched: z.ZodNumber;
        categories: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    tokenEstimate: z.ZodNumber;
}, z.core.$strip>;
export declare const dispatchLinkSchema: z.ZodObject<{
    dispatchId: z.ZodString;
    threadId: z.ZodString;
    linkedAt: z.ZodISODateTime;
}, z.core.$strip>;
export declare const dispatchLinkRequestSchema: z.ZodObject<{
    threadId: z.ZodString;
}, z.core.$strip>;
export declare const settingsDocumentSchema: z.ZodObject<{
    autoSendOptIn: z.ZodObject<{
        chatgpt: z.ZodBoolean;
        claude: z.ZodBoolean;
        gemini: z.ZodBoolean;
    }, z.core.$strip>;
    defaultPacketKind: z.ZodEnum<{
        other: "other";
        research: "research";
        review: "review";
        coding: "coding";
        note: "note";
    }>;
    defaultDispatchTarget: z.ZodEnum<{
        chatgpt: "chatgpt";
        claude: "claude";
        gemini: "gemini";
        codex: "codex";
        claude_code: "claude_code";
        cursor: "cursor";
        other: "other";
    }>;
    screenShareSafeMode: z.ZodBoolean;
    revision: z.ZodString;
}, z.core.$strip>;
export declare const settingsPatchSchema: z.ZodObject<{
    revision: z.ZodString;
    autoSendOptIn: z.ZodOptional<z.ZodObject<{
        chatgpt: z.ZodOptional<z.ZodBoolean>;
        claude: z.ZodOptional<z.ZodBoolean>;
        gemini: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    defaultPacketKind: z.ZodOptional<z.ZodEnum<{
        other: "other";
        research: "research";
        review: "review";
        coding: "coding";
        note: "note";
    }>>;
    defaultDispatchTarget: z.ZodOptional<z.ZodEnum<{
        chatgpt: "chatgpt";
        claude: "claude";
        gemini: "gemini";
        codex: "codex";
        claude_code: "claude_code";
        cursor: "cursor";
        other: "other";
    }>>;
    screenShareSafeMode: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const reviewEventSchema: z.ZodObject<{
    bac_id: z.ZodOptional<z.ZodString>;
    sourceThreadId: z.ZodString;
    sourceTurnOrdinal: z.ZodNumber;
    provider: z.ZodEnum<{
        unknown: "unknown";
        chatgpt: "chatgpt";
        claude: "claude";
        gemini: "gemini";
        codex: "codex";
    }>;
    verdict: z.ZodEnum<{
        agree: "agree";
        disagree: "disagree";
        partial: "partial";
        needs_source: "needs_source";
        open: "open";
    }>;
    reviewerNote: z.ZodString;
    spans: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        comment: z.ZodString;
        capturedAt: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    outcome: z.ZodEnum<{
        save: "save";
        submit_back: "submit_back";
        dispatch_out: "dispatch_out";
    }>;
    createdAt: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strip>;
export declare const reviewEventRecordSchema: z.ZodObject<{
    sourceThreadId: z.ZodString;
    sourceTurnOrdinal: z.ZodNumber;
    provider: z.ZodEnum<{
        unknown: "unknown";
        chatgpt: "chatgpt";
        claude: "claude";
        gemini: "gemini";
        codex: "codex";
    }>;
    verdict: z.ZodEnum<{
        agree: "agree";
        disagree: "disagree";
        partial: "partial";
        needs_source: "needs_source";
        open: "open";
    }>;
    reviewerNote: z.ZodString;
    spans: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        comment: z.ZodString;
        capturedAt: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    outcome: z.ZodEnum<{
        save: "save";
        submit_back: "submit_back";
        dispatch_out: "dispatch_out";
    }>;
    bac_id: z.ZodString;
    createdAt: z.ZodISODateTime;
}, z.core.$strip>;
export declare const dispatchListQuerySchema: z.ZodObject<{
    limit: z.ZodPipe<z.ZodOptional<z.ZodCoercedNumber<unknown>>, z.ZodTransform<number, number | undefined>>;
    since: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strip>;
export declare const auditEventSchema: z.ZodObject<{
    requestId: z.ZodString;
    route: z.ZodString;
    outcome: z.ZodEnum<{
        success: "success";
        failure: "failure";
    }>;
    bac_id: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodISODateTime;
}, z.core.$strip>;
export declare const auditListQuerySchema: z.ZodObject<{
    limit: z.ZodPipe<z.ZodOptional<z.ZodCoercedNumber<unknown>>, z.ZodTransform<number, number | undefined>>;
    since: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strip>;
export declare const reviewListQuerySchema: z.ZodObject<{
    limit: z.ZodPipe<z.ZodOptional<z.ZodCoercedNumber<unknown>>, z.ZodTransform<number, number | undefined>>;
    since: z.ZodOptional<z.ZodISODateTime>;
    threadId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const targetRefSchema: z.ZodObject<{
    provider: z.ZodOptional<z.ZodString>;
    canonicalUrl: z.ZodOptional<z.ZodURL>;
    conversationId: z.ZodOptional<z.ZodString>;
    messageId: z.ZodOptional<z.ZodString>;
    turnOrdinal: z.ZodOptional<z.ZodNumber>;
    role: z.ZodOptional<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
        system: "system";
    }>>;
    quoteHash: z.ZodOptional<z.ZodString>;
    anchorFingerprint: z.ZodOptional<z.ZodString>;
    sourceSnapshotHash: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const reviewDraftClientEventSchema: z.ZodObject<{
    clientEventId: z.ZodString;
    type: z.ZodEnum<{
        "review-draft.span.added": "review-draft.span.added";
        "review-draft.span.removed": "review-draft.span.removed";
        "review-draft.comment.set": "review-draft.comment.set";
        "review-draft.overall.set": "review-draft.overall.set";
        "review-draft.verdict.set": "review-draft.verdict.set";
        "review-draft.discarded": "review-draft.discarded";
    }>;
    payload: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    target: z.ZodOptional<z.ZodObject<{
        provider: z.ZodOptional<z.ZodString>;
        canonicalUrl: z.ZodOptional<z.ZodURL>;
        conversationId: z.ZodOptional<z.ZodString>;
        messageId: z.ZodOptional<z.ZodString>;
        turnOrdinal: z.ZodOptional<z.ZodNumber>;
        role: z.ZodOptional<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
            system: "system";
        }>>;
        quoteHash: z.ZodOptional<z.ZodString>;
        anchorFingerprint: z.ZodOptional<z.ZodString>;
        sourceSnapshotHash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    baseVector: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    clientDeps: z.ZodOptional<z.ZodArray<z.ZodString>>;
    clientCreatedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const reviewDraftEventBatchSchema: z.ZodObject<{
    threadUrl: z.ZodOptional<z.ZodURL>;
    events: z.ZodArray<z.ZodObject<{
        clientEventId: z.ZodString;
        type: z.ZodEnum<{
            "review-draft.span.added": "review-draft.span.added";
            "review-draft.span.removed": "review-draft.span.removed";
            "review-draft.comment.set": "review-draft.comment.set";
            "review-draft.overall.set": "review-draft.overall.set";
            "review-draft.verdict.set": "review-draft.verdict.set";
            "review-draft.discarded": "review-draft.discarded";
        }>;
        payload: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        target: z.ZodOptional<z.ZodObject<{
            provider: z.ZodOptional<z.ZodString>;
            canonicalUrl: z.ZodOptional<z.ZodURL>;
            conversationId: z.ZodOptional<z.ZodString>;
            messageId: z.ZodOptional<z.ZodString>;
            turnOrdinal: z.ZodOptional<z.ZodNumber>;
            role: z.ZodOptional<z.ZodEnum<{
                user: "user";
                assistant: "assistant";
                system: "system";
            }>>;
            quoteHash: z.ZodOptional<z.ZodString>;
            anchorFingerprint: z.ZodOptional<z.ZodString>;
            sourceSnapshotHash: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        baseVector: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        clientDeps: z.ZodOptional<z.ZodArray<z.ZodString>>;
        clientCreatedAtMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const reviewDraftListQuerySchema: z.ZodObject<{
    since: z.ZodOptional<z.ZodCoercedNumber<unknown>>;
}, z.core.$strip>;
export declare const turnsQuerySchema: z.ZodObject<{
    threadUrl: z.ZodURL;
    limit: z.ZodPipe<z.ZodOptional<z.ZodCoercedNumber<unknown>>, z.ZodTransform<number, number | undefined>>;
    role: z.ZodOptional<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
        system: "system";
        unknown: "unknown";
    }>>;
}, z.core.$strip>;
export declare const turnRecordSchema: z.ZodObject<{
    role: z.ZodEnum<{
        user: "user";
        assistant: "assistant";
        system: "system";
        unknown: "unknown";
    }>;
    text: z.ZodString;
    formattedText: z.ZodOptional<z.ZodString>;
    ordinal: z.ZodNumber;
    capturedAt: z.ZodISODateTime;
    sourceSelector: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const annotationCreateSchema: z.ZodUnion<readonly [z.ZodObject<{
    url: z.ZodURL;
    pageTitle: z.ZodString;
    anchor: z.ZodObject<{
        textQuote: z.ZodObject<{
            exact: z.ZodString;
            prefix: z.ZodString;
            suffix: z.ZodString;
        }, z.core.$strip>;
        textPosition: z.ZodObject<{
            start: z.ZodNumber;
            end: z.ZodNumber;
        }, z.core.$strip>;
        cssSelector: z.ZodString;
    }, z.core.$strip>;
    note: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    threadId: z.ZodOptional<z.ZodString>;
    url: z.ZodOptional<z.ZodURL>;
    pageTitle: z.ZodOptional<z.ZodString>;
    term: z.ZodString;
    selectionHint: z.ZodOptional<z.ZodString>;
    sourceTurn: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"assistant_latest">, z.ZodLiteral<"assistant_all">, z.ZodObject<{
        ordinal: z.ZodNumber;
    }, z.core.$strip>]>>;
    anchorPolicy: z.ZodOptional<z.ZodObject<{
        repeatedTerm: z.ZodOptional<z.ZodEnum<{
            first: "first";
            require_hint: "require_hint";
        }>>;
        shortTermMinLength: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    note: z.ZodString;
}, z.core.$strip>]>;
export declare const annotationListQuerySchema: z.ZodObject<{
    url: z.ZodOptional<z.ZodURL>;
    includeDeleted: z.ZodDefault<z.ZodOptional<z.ZodCoercedBoolean<unknown>>>;
    limit: z.ZodPipe<z.ZodOptional<z.ZodCoercedNumber<unknown>>, z.ZodTransform<number, number | undefined>>;
}, z.core.$strip>;
export declare const annotationUpdateSchema: z.ZodObject<{
    note: z.ZodString;
}, z.core.$strip>;
export declare const recallIndexSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        threadId: z.ZodString;
        capturedAt: z.ZodISODateTime;
        text: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const recallGcSchema: z.ZodObject<{
    validIds: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const recallQuerySchema: z.ZodObject<{
    q: z.ZodString;
    limit: z.ZodPipe<z.ZodOptional<z.ZodCoercedNumber<unknown>>, z.ZodTransform<number, number | undefined>>;
    workstreamId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const suggestionQuerySchema: z.ZodObject<{
    limit: z.ZodPipe<z.ZodOptional<z.ZodCoercedNumber<unknown>>, z.ZodTransform<number, number | undefined>>;
    threshold: z.ZodOptional<z.ZodCoercedNumber<unknown>>;
}, z.core.$strip>;
export declare const autoUpdateSchema: z.ZodObject<{
    confirm: z.ZodString;
}, z.core.$strip>;
export declare const bucketSchema: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodString;
    vaultRoot: z.ZodString;
    matchers: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            provider: "provider";
            workstream: "workstream";
            urlPattern: "urlPattern";
        }>;
        value: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const bucketsPutSchema: z.ZodObject<{
    buckets: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        vaultRoot: z.ZodString;
        matchers: z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                provider: "provider";
                workstream: "workstream";
                urlPattern: "urlPattern";
            }>;
            value: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const workstreamTrustPutSchema: z.ZodObject<{
    allowedTools: z.ZodArray<z.ZodEnum<{
        "sidetrack.threads.move": "sidetrack.threads.move";
        "sidetrack.queue.create": "sidetrack.queue.create";
        "sidetrack.workstreams.bump": "sidetrack.workstreams.bump";
        "sidetrack.threads.archive": "sidetrack.threads.archive";
        "sidetrack.threads.unarchive": "sidetrack.threads.unarchive";
    }>>;
}, z.core.$strip>;
export type CaptureEventInput = z.infer<typeof captureEventSchema>;
export type ThreadUpsertInput = z.infer<typeof threadUpsertSchema>;
export type WorkstreamCreateInput = z.infer<typeof workstreamCreateSchema>;
export type WorkstreamUpdateInput = z.infer<typeof workstreamUpdateSchema>;
export type QueueCreateInput = z.infer<typeof queueCreateSchema>;
export type ReminderCreateInput = z.infer<typeof reminderCreateSchema>;
export type ReminderUpdateInput = z.infer<typeof reminderUpdateSchema>;
export type DispatchEventInput = z.infer<typeof dispatchEventSchema>;
export type DispatchEventRecord = z.infer<typeof dispatchEventRecordSchema>;
export type DispatchListQuery = z.infer<typeof dispatchListQuerySchema>;
export type DispatchLinkRecord = z.infer<typeof dispatchLinkSchema>;
export type DispatchLinkRequest = z.infer<typeof dispatchLinkRequestSchema>;
export type AuditEventRecord = z.infer<typeof auditEventSchema>;
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
export type SettingsDocument = z.infer<typeof settingsDocumentSchema>;
export type SettingsPatchInput = z.infer<typeof settingsPatchSchema>;
export type ReviewEventInput = z.infer<typeof reviewEventSchema>;
export type ReviewEvent = z.infer<typeof reviewEventRecordSchema>;
export type ReviewListQuery = z.infer<typeof reviewListQuerySchema>;
export type TurnsQuery = z.infer<typeof turnsQuerySchema>;
export type TurnRecord = z.infer<typeof turnRecordSchema>;
export type SerializedAnchor = z.infer<typeof serializedAnchorSchema>;
export type AnnotationCreateInput = z.infer<typeof annotationCreateSchema>;
export type AnnotationListQuery = z.infer<typeof annotationListQuerySchema>;
export type RecallIndexInput = z.infer<typeof recallIndexSchema>;
export type RecallQuery = z.infer<typeof recallQuerySchema>;
export type SuggestionQuery = z.infer<typeof suggestionQuerySchema>;
export type BucketRecord = z.infer<typeof bucketSchema>;
export type CodingTool = z.infer<typeof codingToolSchema>;
export type CodingAttachTokenCreateInput = z.infer<typeof codingAttachTokenCreateSchema>;
export type CodingAttachTokenRecord = z.infer<typeof codingAttachTokenSchema>;
export type CodingSessionRegisterInput = z.infer<typeof codingSessionRegisterSchema>;
export type CodingSessionRecord = z.infer<typeof codingSessionSchema>;
export type CodingSessionListQuery = z.infer<typeof codingSessionListQuerySchema>;
export {};
//# sourceMappingURL=schemas.d.ts.map