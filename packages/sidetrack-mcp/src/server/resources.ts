// Phase 5 of the spec-aligned refactor: durable Sidetrack state
// surfaces as MCP resources alongside the existing tool surface.
// Agents that prefer the resource model — e.g. Claude desktop's
// resource-aware UI — can `resources/list` and `readResource` to
// inspect threads, dispatches, and workstream context packs without
// having to discover individual tool calls.
//
// Each resource is a templated URI under the `sidetrack://` scheme.
// The read callbacks reuse the same companion-backed and live-vault
// readers the tool layer uses, so the data shapes are identical and
// the source-of-truth is shared.
//
// As of Phase 5 the legacy sidetrack.threads.read_md and
// sidetrack.workstreams.read_md tools are removed; the equivalent
// content is exposed exclusively via these resources.

import {
  McpServer,
  ResourceTemplate,
  type ReadResourceTemplateCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';

import type { CompanionWriteClient, SidetrackMcpReader } from './mcpServer.js';

const stringify = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const textContents = (uri: URL, value: unknown) => ({
  contents: [
    {
      uri: uri.toString(),
      mimeType: 'application/json',
      text: stringify(value),
    },
  ],
});

const markdownContents = (uri: URL, markdown: string) => ({
  contents: [
    {
      uri: uri.toString(),
      mimeType: 'text/markdown',
      text: markdown,
    },
  ],
});

const requireVariable = (variables: Record<string, unknown>, key: string): string => {
  const raw = variables[key];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`Resource URI missing variable '${key}'.`);
  }
  return raw;
};

export const registerResources = (
  server: McpServer,
  reader: SidetrackMcpReader,
  companionClient?: CompanionWriteClient,
): void => {
  // sidetrack://thread/{threadId}
  // Thread metadata (title, threadUrl, provider, lastSeenAt, …)
  // pulled from the live vault snapshot.
  const threadRead: ReadResourceTemplateCallback = async (uri, variables) => {
    const threadId = requireVariable(variables as Record<string, unknown>, 'threadId');
    const snapshot = await reader.readSnapshot();
    const thread = snapshot.threads.find((entry) => entry.bac_id === threadId);
    if (thread === undefined) {
      throw new Error(`Thread ${threadId} not found in the live vault snapshot.`);
    }
    return textContents(uri, thread);
  };
  server.registerResource(
    'sidetrack-thread',
    new ResourceTemplate('sidetrack://thread/{threadId}', { list: undefined }),
    {
      title: 'Sidetrack thread',
      description: 'Tracked thread metadata (title, URL, provider, status).',
      mimeType: 'application/json',
    },
    threadRead,
  );

  // sidetrack://thread/{threadId}/turns
  // Captured user/assistant turns for the thread, in ordinal order.
  const turnsRead: ReadResourceTemplateCallback = async (uri, variables) => {
    const threadId = requireVariable(variables as Record<string, unknown>, 'threadId');
    const snapshot = await reader.readSnapshot();
    const thread = snapshot.threads.find((entry) => entry.bac_id === threadId);
    if (thread === undefined) {
      throw new Error(`Thread ${threadId} not found in the live vault snapshot.`);
    }
    const result = await reader.readTurns({ threadUrl: thread.threadUrl ?? '', limit: 100 });
    return textContents(uri, result);
  };
  server.registerResource(
    'sidetrack-thread-turns',
    new ResourceTemplate('sidetrack://thread/{threadId}/turns', { list: undefined }),
    {
      title: 'Sidetrack thread turns',
      description: 'Captured user/assistant turns for the thread.',
      mimeType: 'application/json',
    },
    turnsRead,
  );

  // sidetrack://thread/{threadId}/annotations
  // Annotations attached to the thread's URL. Companion-backed.
  const annotationsRead: ReadResourceTemplateCallback = async (uri, variables) => {
    const threadId = requireVariable(variables as Record<string, unknown>, 'threadId');
    if (companionClient?.listAnnotations === undefined) {
      throw new Error(
        'sidetrack-mcp was started without --companion-url / --bridge-key; thread annotations resource is unavailable.',
      );
    }
    const snapshot = await reader.readSnapshot();
    const thread = snapshot.threads.find((entry) => entry.bac_id === threadId);
    if (thread === undefined) {
      throw new Error(`Thread ${threadId} not found in the live vault snapshot.`);
    }
    const data = await companionClient.listAnnotations({
      ...(thread.threadUrl === undefined ? {} : { url: thread.threadUrl }),
    });
    return textContents(uri, { data });
  };
  server.registerResource(
    'sidetrack-thread-annotations',
    new ResourceTemplate('sidetrack://thread/{threadId}/annotations', { list: undefined }),
    {
      title: 'Sidetrack thread annotations',
      description: 'Annotations the user (or agents) pinned on the thread URL.',
      mimeType: 'application/json',
    },
    annotationsRead,
  );

  // sidetrack://thread/{threadId}/markdown
  // Vault-rendered markdown sidecar (same content the
  // sidetrack.threads.read_md tool returns).
  const threadMarkdownRead: ReadResourceTemplateCallback = async (uri, variables) => {
    const threadId = requireVariable(variables as Record<string, unknown>, 'threadId');
    if (companionClient?.readThreadMarkdown === undefined) {
      throw new Error(
        'sidetrack-mcp was started without --companion-url / --bridge-key; thread markdown resource is unavailable.',
      );
    }
    const result = await companionClient.readThreadMarkdown({ bac_id: threadId });
    const markdown =
      typeof result['markdown'] === 'string' ? (result['markdown'] as string) : '';
    return markdownContents(uri, markdown);
  };
  server.registerResource(
    'sidetrack-thread-markdown',
    new ResourceTemplate('sidetrack://thread/{threadId}/markdown', { list: undefined }),
    {
      title: 'Sidetrack thread markdown',
      description: 'Vault-rendered Markdown sidecar for the thread.',
      mimeType: 'text/markdown',
    },
    threadMarkdownRead,
  );

  // sidetrack://dispatch/{dispatchId}
  // Dispatch event record. Adds the linked thread when the link
  // table has a record (companion's GET /v1/dispatches/:id/link is
  // exposed via CompanionWriteClient.awaitCaptureForDispatch only —
  // for the resource read, the thread join is best-effort and the
  // dispatch record is returned even when no link exists yet.
  const dispatchRead: ReadResourceTemplateCallback = async (uri, variables) => {
    const dispatchId = requireVariable(variables as Record<string, unknown>, 'dispatchId');
    const dispatches = await reader.readDispatches({ limit: 200 });
    const dispatch = dispatches.data.find((entry) => entry.bac_id === dispatchId);
    if (dispatch === undefined) {
      throw new Error(`Dispatch ${dispatchId} not found in the live vault.`);
    }
    return textContents(uri, dispatch);
  };
  server.registerResource(
    'sidetrack-dispatch',
    new ResourceTemplate('sidetrack://dispatch/{dispatchId}', { list: undefined }),
    {
      title: 'Sidetrack dispatch',
      description: 'Dispatch event record from the local vault.',
      mimeType: 'application/json',
    },
    dispatchRead,
  );

  // sidetrack://workstream/{workstreamId}/context
  // Context pack equivalent — same content the
  // sidetrack.workstreams.context_pack tool returns, surfaced as
  // a markdown resource.
  const workstreamContextRead: ReadResourceTemplateCallback = async (uri, variables) => {
    const workstreamId = requireVariable(
      variables as Record<string, unknown>,
      'workstreamId',
    );
    const snapshot = await reader.readSnapshot();
    const workstream = snapshot.workstreams.find((entry) => entry.bac_id === workstreamId);
    if (workstream === undefined) {
      throw new Error(`Workstream ${workstreamId} not found in the live vault.`);
    }
    const threads = snapshot.threads.filter(
      (thread) => thread.primaryWorkstreamId === workstreamId,
    );
    const queueItems = snapshot.queueItems.filter((item) => item.targetId === workstreamId);
    const lines: readonly string[] = [
      '# Sidetrack Context Pack',
      '',
      '## Workstream',
      `- ${workstream.title ?? workstream.bac_id}`,
      '',
      '## Threads',
      ...threads.map(
        (thread) => `- ${thread.title ?? thread.threadUrl ?? thread.bac_id}`,
      ),
      '',
      '## Queue items',
      ...queueItems.map((item) => `- ${item.text ?? item.bac_id}`),
    ];
    return markdownContents(uri, lines.join('\n'));
  };
  server.registerResource(
    'sidetrack-workstream-context',
    new ResourceTemplate('sidetrack://workstream/{workstreamId}/context', { list: undefined }),
    {
      title: 'Sidetrack workstream context pack',
      description: 'Threads + queue items rolled up for the workstream.',
      mimeType: 'text/markdown',
    },
    workstreamContextRead,
  );
};
