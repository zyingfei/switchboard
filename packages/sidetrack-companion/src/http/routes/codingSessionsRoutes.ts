// Coding-session routes: attach-tokens, create, list, and delete.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { codingAttachTokenCreateSchema, codingSessionListQuerySchema, codingSessionRegisterSchema } from '../schemas.js';

import { readBody } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

export const codingSessionsRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/coding-sessions\/attach-tokens$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const input = codingAttachTokenCreateSchema.parse(await readBody(request));
      const result = await context.vaultWriter.createCodingAttachToken(input, requestId);
      return [201, { data: result }];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/coding-sessions$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const input = codingSessionRegisterSchema.parse(await readBody(request));
      const result = await context.vaultWriter.registerCodingSession(input, requestId);
      return [201, { data: result }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/coding-sessions$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = codingSessionListQuerySchema.parse({
        token: url.searchParams.get('token') ?? undefined,
        workstreamId: url.searchParams.get('workstreamId') ?? undefined,
      });
      return [200, { data: await context.vaultWriter.listCodingSessions(query) }];
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/coding-sessions\/(?<codingSessionId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (_request, requestId, match, context) => {
      if (match.codingSessionId === undefined) {
        throw new Error('Missing codingSessionId path parameter.');
      }
      const result = await context.vaultWriter.detachCodingSession(
        match.codingSessionId,
        requestId,
      );
      return [200, { data: result }];
    },
  },
];
